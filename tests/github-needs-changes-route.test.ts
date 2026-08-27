import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_NEEDS_CHANGES_ROUTE_PATH,
  handleGitHubNeedsChangesRequest,
  type NeedsChangesWorkerRuntime,
} from "../src/worker/github-needs-changes-route.js";
import { CloudflareAccessAuthenticationError } from "../src/worker/access-request-authenticator.js";
import {
  NeedsChangesDecisionError,
  type NeedsChangesDecisionRequest,
  type NeedsChangesDecisionResult,
} from "../src/shared/needs-changes-decision.js";
import type { ManagedProjectPolicy } from "../src/shared/project-policy.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const HEAD = "1111111111111111111111111111111111111111";
const MAIN = "2222222222222222222222222222222222222222";
const REQUEST_ID = "request_221_00001";

const enabledPolicy: ManagedProjectPolicy = {
  id: "hermes-tech",
  displayName: "Hermes Tech",
  repository: REPOSITORY,
  enabled: true,
  githubReadEnabled: true,
  canRequestChanges: true,
  canMerge: false,
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
    body: "Please address the reviewed issues.",
    ...overrides,
  };
}

function request(
  body: Record<string, unknown> = payload(),
  options: { method?: string; path?: string; contentType?: string } = {},
): Request {
  return new Request(`https://control.rozkalns.net${options.path ?? GITHUB_NEEDS_CHANGES_ROUTE_PATH}`, {
    method: options.method ?? "POST",
    headers: { "Content-Type": options.contentType ?? "application/json" },
    body: options.method === "GET" ? undefined : JSON.stringify(body),
  });
}

function success(input: NeedsChangesDecisionRequest): NeedsChangesDecisionResult {
  return {
    status: "CHANGES_REQUESTED",
    requestId: input.requestId,
    actor: input.actor,
    repository: input.repository,
    issueNumber: input.issueNumber,
    pullNumber: input.pullNumber,
    expectedHeadSha: input.expectedHeadSha,
    observedHeadSha: input.expectedHeadSha,
    expectedMainSha: input.expectedMainSha,
    observedMainSha: input.expectedMainSha,
    observedAt: "2026-08-16T21:15:00.000Z",
    reviewId: "12345",
    reviewUrl: `https://github.com/${input.repository}/pull/${input.pullNumber}#pullrequestreview-12345`,
    submittedAt: "2026-08-16T21:15:01.000Z",
  };
}

function createRuntime(options: {
  authError?: Error;
  executeError?: Error;
} = {}): {
  runtime: NeedsChangesWorkerRuntime;
  state: { authCalls: number; executeCalls: number; executed: NeedsChangesDecisionRequest | null };
} {
  const state = { authCalls: 0, executeCalls: 0, executed: null as NeedsChangesDecisionRequest | null };
  const runtime: NeedsChangesWorkerRuntime = {
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

test("detached Needs changes route rejects unsupported method, query and wrong media type before authentication", async () => {
  const { runtime, state } = createRuntime();

  const methodResponse = await handleGitHubNeedsChangesRequest(
    request(payload(), { method: "PUT" }),
    runtime,
  );
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "GET, POST");

  const queryResponse = await handleGitHubNeedsChangesRequest(
    request(payload(), { path: `${GITHUB_NEEDS_CHANGES_ROUTE_PATH}?extra=1` }),
    runtime,
  );
  assert.equal(queryResponse.status, 400);

  const mediaResponse = await handleGitHubNeedsChangesRequest(
    request(payload(), { contentType: "text/plain" }),
    runtime,
  );
  assert.equal(mediaResponse.status, 415);
  assert.equal(state.authCalls, 0);
  assert.equal(state.executeCalls, 0);
});

test("GET auth diagnostic uses the same authenticator without executing a decision or exposing identity", async () => {
  const { runtime, state } = createRuntime();
  const response = await handleGitHubNeedsChangesRequest(
    request(payload(), { method: "GET" }),
    runtime,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { status: "AUTHENTICATED" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
});

test("GET auth diagnostic exposes only a bounded typed failure reason and never executes a decision", async () => {
  const { runtime, state } = createRuntime({
    authError: new CloudflareAccessAuthenticationError("ACCESS_JWT_AUDIENCE_INVALID"),
  });
  const response = await handleGitHubNeedsChangesRequest(
    request(payload(), { method: "GET" }),
    runtime,
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await json(response), {
    error: "ACCESS_AUTHENTICATION_FAILED",
    diagnostic: "ACCESS_JWT_AUDIENCE_INVALID",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
});

test("GET auth diagnostic hides unknown authentication errors", async () => {
  const secret = "secret-jwt-material-must-not-escape";
  const { runtime, state } = createRuntime({ authError: new Error(secret) });
  const response = await handleGitHubNeedsChangesRequest(
    request(payload(), { method: "GET" }),
    runtime,
  );

  assert.equal(response.status, 403);
  const body = await json(response);
  assert.deepEqual(body, { error: "ACCESS_AUTHENTICATION_FAILED" });
  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
});

test("POST Access authentication failure remains generic and prevents action execution", async () => {
  const { runtime, state } = createRuntime({
    authError: new CloudflareAccessAuthenticationError("ACCESS_JWT_AUDIENCE_INVALID"),
  });
  const response = await handleGitHubNeedsChangesRequest(request(), runtime);

  assert.equal(response.status, 403);
  const body = await json(response);
  assert.deepEqual(body, { error: "ACCESS_AUTHENTICATION_FAILED" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
  assert.equal(Object.hasOwn(body, "diagnostic"), false);
});

test("current capability-false managed project is denied before decision executor", async () => {
  const { runtime, state } = createRuntime();
  const response = await handleGitHubNeedsChangesRequest(request(), runtime);

  assert.equal(response.status, 403);
  assert.deepEqual(await json(response), { error: "ACTION_NOT_ALLOWED" });
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
});

test("handler rejects actor injection and malformed exact body after authenticating", async () => {
  const { runtime, state } = createRuntime();
  const response = await handleGitHubNeedsChangesRequest(
    request(payload({ actor: { subject: "forged", email: "forged@example.invalid" } })),
    runtime,
    { resolveProject: () => enabledPolicy },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await json(response), { error: "INVALID_REQUEST" });
  assert.equal(state.authCalls, 1);
  assert.equal(state.executeCalls, 0);
});

test("verified Access principal is the only actor passed to the decision executor", async () => {
  const { runtime, state } = createRuntime();
  const response = await handleGitHubNeedsChangesRequest(request(), runtime, {
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

  const body = await json(response);
  assert.equal(body.status, "CHANGES_REQUESTED");
  assert.equal(body.requestId, REQUEST_ID);
  assert.equal(body.observedHeadSha, HEAD);
  assert.equal(body.observedMainSha, MAIN);
  assert.equal(Object.hasOwn(body, "actor"), false);
  assert.equal(JSON.stringify(body).includes("andris@example.invalid"), false);
});

test("unknown write outcome is bounded and explicitly non-retryable", async () => {
  const { runtime, state } = createRuntime({
    executeError: new NeedsChangesDecisionError("WRITE_OUTCOME_UNKNOWN", true),
  });
  const response = await handleGitHubNeedsChangesRequest(request(), runtime, {
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

test("missing detached runtime fails closed without reading the request body", async () => {
  const response = await handleGitHubNeedsChangesRequest(request(), null);
  assert.equal(response.status, 503);
  assert.deepEqual(await json(response), { error: "RUNTIME_UNAVAILABLE" });
});
