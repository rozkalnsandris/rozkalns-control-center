import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_MERGE_ROUTE_PATH,
  handleGitHubMergeRequest,
  type MergeWorkerRuntime,
} from "../src/worker/github-merge-route.js";
import {
  MergeDecisionError,
  type MergeDecisionRequest,
  type MergeDecisionResult,
} from "../src/shared/merge-decision.js";
import type { ManagedProjectPolicy } from "../src/shared/project-policy.js";
import { CloudflareAccessAuthenticationError } from "../src/worker/access-request-authenticator.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const HEAD = "1111111111111111111111111111111111111111";
const MAIN = "2222222222222222222222222222222222222222";
const MERGE_SHA = "3333333333333333333333333333333333333333";
const REQUEST_ID = "request_395_00001";
const AUDIENCE_FINGERPRINT = "a".repeat(64);

const enabledPolicy: ManagedProjectPolicy = {
  id: "hermes-tech",
  displayName: "Hermes Tech",
  repository: REPOSITORY,
  enabled: true,
  githubReadEnabled: true,
  canRequestChanges: false,
  canMerge: true,
  canLater: false,
  productionAdapter: "rpi5",
};

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    repository: REPOSITORY,
    issueNumber: 47,
    pullNumber: 48,
    expectedHeadSha: HEAD,
    expectedMainSha: MAIN,
    mergeMethod: "squash",
    ...overrides,
  };
}

function request(
  body: Record<string, unknown> = payload(),
  options: { method?: string; path?: string; contentType?: string } = {},
): Request {
  const method = options.method ?? "POST";
  return new Request(`https://control.rozkalns.net${options.path ?? GITHUB_MERGE_ROUTE_PATH}`, {
    method,
    headers: { "Content-Type": options.contentType ?? "application/json" },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
}

function success(input: MergeDecisionRequest): MergeDecisionResult {
  return {
    status: "MERGED",
    requestId: input.requestId,
    actor: input.actor,
    repository: input.repository,
    issueNumber: input.issueNumber,
    pullNumber: input.pullNumber,
    mergeMethod: input.mergeMethod,
    expectedHeadSha: input.expectedHeadSha,
    observedHeadSha: input.expectedHeadSha,
    expectedMainSha: input.expectedMainSha,
    observedMainSha: input.expectedMainSha,
    observedAt: "2026-08-24T13:40:00.000Z",
    mergeSha: MERGE_SHA,
  };
}

function createRuntime(options: {
  authError?: Error;
  executeError?: Error;
} = {}): {
  runtime: MergeWorkerRuntime;
  state: { authCalls: number; executeCalls: number; executed: MergeDecisionRequest | null };
} {
  const state = { authCalls: 0, executeCalls: 0, executed: null as MergeDecisionRequest | null };
  const runtime: MergeWorkerRuntime = {
    authenticator: {
      async authenticateRequest() {
        state.authCalls += 1;
        if (options.authError) throw options.authError;
        return { subject: "access-subject", email: "andris@example.invalid" };
      },
    },
    async executeDecision(input) {
      state.executeCalls += 1;
      state.executed = input;
      if (options.executeError) throw options.executeError;
      return success(input);
    },
  };
  return { runtime, state };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("detached Merge route rejects unsupported method, query and wrong media type before authentication", async () => {
  const { runtime, state } = createRuntime();

  const patchResponse = await handleGitHubMergeRequest(request(payload(), { method: "PATCH" }), runtime);
  assert.equal(patchResponse.status, 405);
  assert.equal(patchResponse.headers.get("allow"), "GET, POST");

  const queryResponse = await handleGitHubMergeRequest(
    request(payload(), { path: `${GITHUB_MERGE_ROUTE_PATH}?extra=1` }),
    runtime,
  );
  assert.equal(queryResponse.status, 400);

  const mediaResponse = await handleGitHubMergeRequest(
    request(payload(), { contentType: "text/plain" }),
    runtime,
  );
  assert.equal(mediaResponse.status, 415);
  assert.equal(state.authCalls, 0);
  assert.equal(state.executeCalls, 0);
});

test("GET authenticates only and can never execute a Merge decision", async () => {
  const { runtime, state } = createRuntime();
  const response = await handleGitHubMergeRequest(request(payload(), { method: "GET" }), runtime);

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { status: "AUTHENTICATED" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
  assert.equal(state.executed, null);
});

test("GET projects only bounded typed audience diagnostics and no raw audience", async () => {
  const rawAudience = "must-never-escape";
  const authError = new CloudflareAccessAuthenticationError(
    "ACCESS_JWT_AUDIENCE_INVALID",
    { shape: "ARRAY", count: 1, sha256: [AUDIENCE_FINGERPRINT] },
  );
  const { runtime, state } = createRuntime({ authError });
  const response = await handleGitHubMergeRequest(request(payload(), { method: "GET" }), runtime);

  assert.equal(response.status, 403);
  const body = await json(response);
  assert.deepEqual(body, {
    error: "ACCESS_AUTHENTICATION_FAILED",
    diagnostic: "ACCESS_JWT_AUDIENCE_INVALID",
    audience: {
      shape: "ARRAY",
      count: 1,
      sha256: [AUDIENCE_FINGERPRINT],
    },
  });
  assert.equal(JSON.stringify(body).includes(rawAudience), false);
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
});

test("GET unknown authentication failure remains generic and non-mutating", async () => {
  const secret = "unknown-auth-secret";
  const { runtime, state } = createRuntime({ authError: new Error(secret) });
  const response = await handleGitHubMergeRequest(request(payload(), { method: "GET" }), runtime);

  assert.equal(response.status, 403);
  const body = await json(response);
  assert.deepEqual(body, { error: "ACCESS_AUTHENTICATION_FAILED" });
  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
});

test("POST Access authentication failure stays generic and prevents Merge execution", async () => {
  const authError = new CloudflareAccessAuthenticationError(
    "ACCESS_JWT_AUDIENCE_INVALID",
    { shape: "STRING", count: 1, sha256: [AUDIENCE_FINGERPRINT] },
  );
  const { runtime, state } = createRuntime({ authError });
  const response = await handleGitHubMergeRequest(request(), runtime);

  assert.equal(response.status, 403);
  const body = await json(response);
  assert.deepEqual(body, { error: "ACCESS_AUTHENTICATION_FAILED" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
  assert.equal(JSON.stringify(body).includes(AUDIENCE_FINGERPRINT), false);
  assert.equal(JSON.stringify(body).includes("ACCESS_JWT_AUDIENCE_INVALID"), false);
});

test("current capability-false managed project is denied before Merge executor", async () => {
  const { runtime, state } = createRuntime();
  const response = await handleGitHubMergeRequest(request(), runtime);

  assert.equal(response.status, 403);
  assert.deepEqual(await json(response), { error: "ACTION_NOT_ALLOWED" });
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
});

test("handler rejects actor injection, unknown fields and unsupported Merge methods", async () => {
  const { runtime, state } = createRuntime();

  const actorResponse = await handleGitHubMergeRequest(
    request(payload({ actor: { subject: "forged", email: "forged@example.invalid" } })),
    runtime,
    { resolveProject: () => enabledPolicy },
  );
  assert.equal(actorResponse.status, 400);

  const methodResponse = await handleGitHubMergeRequest(
    request(payload({ mergeMethod: "fast-forward" })),
    runtime,
    { resolveProject: () => enabledPolicy },
  );
  assert.equal(methodResponse.status, 400);
  assert.equal(state.executeCalls, 0);
});

test("verified Access principal is the only actor passed to the Merge decision executor", async () => {
  const { runtime, state } = createRuntime();
  const response = await handleGitHubMergeRequest(request(), runtime, {
    resolveProject: (repository) => repository === REPOSITORY ? enabledPolicy : null,
  });

  assert.equal(response.status, 200);
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 1);
  assert.deepEqual(state.executed?.actor, {
    subject: "access-subject",
    email: "andris@example.invalid",
  });
  assert.equal(state.executed?.repository, REPOSITORY);
  assert.equal(state.executed?.mergeMethod, "squash");

  const body = await json(response);
  assert.equal(body.status, "MERGED");
  assert.equal(body.requestId, REQUEST_ID);
  assert.equal(body.mergeSha, MERGE_SHA);
  assert.equal(Object.hasOwn(body, "actor"), false);
  assert.equal(JSON.stringify(body).includes("andris@example.invalid"), false);
});

test("unknown Merge write outcome is bounded and explicitly non-retryable", async () => {
  const { runtime, state } = createRuntime({
    executeError: new MergeDecisionError("WRITE_OUTCOME_UNKNOWN", true),
  });
  const response = await handleGitHubMergeRequest(request(), runtime, {
    resolveProject: () => enabledPolicy,
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await json(response), {
    error: "WRITE_OUTCOME_UNKNOWN",
    retryable: false,
  });
  assert.equal(state.executeCalls, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("missing detached Merge runtime fails closed without reading the request body", async () => {
  const response = await handleGitHubMergeRequest(request(), null);
  assert.equal(response.status, 503);
  assert.deepEqual(await json(response), { error: "RUNTIME_UNAVAILABLE" });
});
