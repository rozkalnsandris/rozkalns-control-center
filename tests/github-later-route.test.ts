import assert from "node:assert/strict";
import test from "node:test";

import { LaterActionError, type LaterActionResult } from "../src/shared/later-action.js";
import type { ManagedProjectPolicy } from "../src/shared/project-policy.js";
import {
  GITHUB_LATER_ROUTE_PATH,
  handleGitHubLaterRequest,
  type LaterWorkerRuntime,
} from "../src/worker/github-later-route.js";

const PROJECT: ManagedProjectPolicy = {
  id: "ops-workflows",
  displayName: "Ops Workflows",
  repository: "rozkalnsandris/ops-workflows",
  enabled: true,
  githubReadEnabled: true,
  canRequestChanges: true,
  canMerge: false,
  canLater: true,
  productionAdapter: "none",
};

const BODY = {
  repository: PROJECT.repository,
  decisionId: "decision-1",
  expectedStateFingerprint: "later-v1-0123456789abcdef",
} as const;

function request(body: unknown = BODY, method = "POST"): Request {
  return new Request(`https://control.example${GITHUB_LATER_ROUTE_PATH}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function runtime(
  execute: LaterWorkerRuntime["executeDecision"] = async (input) => ({
    status: "DEFERRED",
    repository: input.repository,
    projectId: PROJECT.id,
    decisionId: input.decisionId,
    stateFingerprint: input.expectedStateFingerprint,
    observedAt: "2026-08-28T08:20:00.000Z",
  }),
): LaterWorkerRuntime {
  return {
    authenticator: {
      async authenticateRequest() {
        return { subject: "user-123", email: "andris@example.invalid" };
      },
    },
    executeDecision: execute,
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("Later route is strict POST JSON with no-store responses", async () => {
  const wrongMethod = await handleGitHubLaterRequest(request(undefined, "GET"), runtime());
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal(wrongMethod.headers.get("cache-control"), "no-store");

  const extraKey = await handleGitHubLaterRequest(
    request({ ...BODY, extra: true }),
    runtime(),
    { resolveProject: () => PROJECT },
  );
  assert.equal(extraKey.status, 400);
  assert.deepEqual(await json(extraKey), { error: "INVALID_REQUEST" });
});

test("Later route fails closed when runtime or Access authentication is unavailable", async () => {
  const unavailable = await handleGitHubLaterRequest(request(), null);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await json(unavailable), { error: "RUNTIME_UNAVAILABLE" });

  const authFailure = await handleGitHubLaterRequest(request(), {
    authenticator: {
      async authenticateRequest() {
        throw new Error("bad jwt");
      },
    },
    async executeDecision(): Promise<LaterActionResult> {
      throw new Error("must not execute");
    },
  });
  assert.equal(authFailure.status, 403);
  assert.deepEqual(await json(authFailure), { error: "ACCESS_AUTHENTICATION_FAILED" });
});

test("Later route capability gate blocks current disabled projects before executeDecision", async () => {
  let executions = 0;
  const response = await handleGitHubLaterRequest(
    request(),
    runtime(async () => {
      executions += 1;
      throw new Error("must not execute");
    }),
    { resolveProject: () => null },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await json(response), { error: "ACTION_NOT_ALLOWED" });
  assert.equal(executions, 0);
});

test("Later route passes only bounded request identity and authenticated actor to runtime", async () => {
  let observed: Parameters<LaterWorkerRuntime["executeDecision"]>[0] | null = null;
  const response = await handleGitHubLaterRequest(
    request(),
    runtime(async (input) => {
      observed = input;
      return {
        status: "REPLAYED",
        repository: input.repository,
        projectId: PROJECT.id,
        decisionId: input.decisionId,
        stateFingerprint: input.expectedStateFingerprint,
        observedAt: "2026-08-28T08:20:00.000Z",
      };
    }),
    { resolveProject: () => PROJECT },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(observed, {
    ...BODY,
    actor: { subject: "user-123", email: "andris@example.invalid" },
  });
  assert.deepEqual(await json(response), {
    status: "REPLAYED",
    repository: PROJECT.repository,
    projectId: PROJECT.id,
    decisionId: BODY.decisionId,
    stateFingerprint: BODY.expectedStateFingerprint,
    observedAt: "2026-08-28T08:20:00.000Z",
  });
});

test("Later route maps stale-state and persistence conflicts to 409", async () => {
  for (const code of ["AUTHORIZATION_STALE_STATE", "PERSISTENCE_CONFLICT"] as const) {
    const response = await handleGitHubLaterRequest(
      request(),
      runtime(async () => {
        throw new LaterActionError(code);
      }),
      { resolveProject: () => PROJECT },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await json(response), { error: code });
  }
});
