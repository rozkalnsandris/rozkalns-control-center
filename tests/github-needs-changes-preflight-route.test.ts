import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GitHubActiveBranchRulesReaderError } from "../src/integrations/github/active-branch-rules-reader.js";
import { GitHubAuthoritativeReadProviderError } from "../src/integrations/github/authoritative-read-provider.js";
import { GitHubClassicBranchProtectionReaderError } from "../src/integrations/github/classic-branch-protection-reader.js";
import { CloudflareGitHubRuntimeError } from "../src/integrations/github/cloudflare-worker-runtime.js";
import { GitHubTransportStageDiagnosticError } from "../src/integrations/github/credential-stage-diagnostics.js";
import { GitHubGraphqlMergeStateError } from "../src/integrations/github/graphql-merge-state-transport.js";
import { GitHubRestReadError } from "../src/integrations/github/rest-read-transport.js";
import type { AuthoritativeReconciliationResult } from "../src/shared/authoritative-reconciliation.js";
import {
  GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH,
  executeLiveGitHubNeedsChangesPreflight,
  handleGitHubNeedsChangesPreflightRequest,
  type LiveGitHubNeedsChangesPreflightInput,
} from "../src/worker/github-needs-changes-preflight-route.js";

const REPOSITORY = "rozkalnsandris/ops-workflows";
const OBSERVED_AT = "2026-08-18T19:20:00.000Z";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";

const bindings = {
  GITHUB_APP_PRIVATE_KEY_PEM: "test-only-not-used",
  GITHUB_APP_CLIENT_ID: "test-client",
  GITHUB_APP_INSTALLATION_ID: "1",
};

const projectedResult = {
  kind: "PROJECTED",
  repository: REPOSITORY,
  issueNumber: 4,
  pullNumber: 3,
  observedAt: OBSERVED_AT,
  commitStatusCoverage: "NOT_REQUESTED",
  policy: {
    coverage: "COMPLETE",
    sources: ["GITHUB_ACTIVE_RULES", "GITHUB_CLASSIC_BRANCH_PROTECTION"],
    blockedReasons: [],
  },
  decision: {} as never,
} as const satisfies AuthoritativeReconciliationResult;

function request(query: string, method = "GET") {
  return new Request(`https://control.invalid${GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH}?${query}`, {
    method,
  });
}

function validRequest() {
  return request(`repository=${encodeURIComponent(REPOSITORY)}&issue=4&pull=3`);
}

async function projectFailure(error: Error) {
  return handleGitHubNeedsChangesPreflightRequest(
    validRequest(),
    bindings,
    OBSERVED_AT,
    async () => {
      throw error;
    },
  );
}

async function expectDiagnostic(error: Error, status: number, expected: Record<string, unknown>) {
  const response = await projectFailure(error);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), expected);
}

test("GET-only Needs changes preflight returns bounded normalized COMPLETE evidence", async () => {
  let captured: LiveGitHubNeedsChangesPreflightInput | null = null;
  const response = await handleGitHubNeedsChangesPreflightRequest(
    validRequest(),
    bindings,
    OBSERVED_AT,
    async (input) => {
      captured = input;
      return projectedResult;
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), projectedResult);
  assert.deepEqual(captured, {
    bindings,
    repository: REPOSITORY,
    issueNumber: 4,
    pullNumber: 3,
    observedAt: OBSERVED_AT,
  });
});

test("preflight rejects malformed, duplicate, extra and non-Needs-changes repositories before reads", async () => {
  const invalidQueries = [
    `repository=${encodeURIComponent(REPOSITORY)}&issue=4`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=4&pull=3&extra=1`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=4&issue=5&pull=3`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=0&pull=3`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=-1&pull=3`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=1.5&pull=3`,
    `repository=${encodeURIComponent("rozkalnsandris/hermes-tech")}&issue=4&pull=3`,
    `repository=${encodeURIComponent("rozkalnsandris/hermes-email-skill")}&issue=4&pull=3`,
  ];

  let calls = 0;
  for (const query of invalidQueries) {
    const response = await handleGitHubNeedsChangesPreflightRequest(
      request(query),
      bindings,
      OBSERVED_AT,
      async () => {
        calls += 1;
        return projectedResult;
      },
    );
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "INVALID_REQUEST" });
  }
  assert.equal(calls, 0);
});

test("preflight rejects POST and unrelated paths before executor", async () => {
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return projectedResult;
  };

  const postResponse = await handleGitHubNeedsChangesPreflightRequest(
    request(`repository=${encodeURIComponent(REPOSITORY)}&issue=4&pull=3`, "POST"),
    bindings,
    OBSERVED_AT,
    executor,
  );
  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get("allow"), "GET");
  assert.equal(postResponse.headers.get("cache-control"), "no-store");

  const unrelatedResponse = await handleGitHubNeedsChangesPreflightRequest(
    new Request("https://control.invalid/api/other"),
    bindings,
    OBSERVED_AT,
    executor,
  );
  assert.equal(unrelatedResponse.status, 404);
  assert.equal(calls, 0);
});

test("live preflight executor uses elevated Needs changes read context and never ordinary context", async () => {
  let elevatedContextCalls = 0;
  let reconcileCalls = 0;
  const provider = {} as never;
  const branchPolicyReader = {} as never;

  const result = await executeLiveGitHubNeedsChangesPreflight(
    {
      bindings,
      repository: REPOSITORY,
      issueNumber: 4,
      pullNumber: 3,
      observedAt: OBSERVED_AT,
    },
    {
      createRuntime: () => ({
        clientId: "test-client",
        installationId: 1,
        createRepositoryReadContext() {
          throw new Error("ordinary read context must not be used for Needs changes preflight");
        },
        createRepositoryNeedsChangesReadContext(repository, observedAt) {
          elevatedContextCalls += 1;
          assert.equal(repository, REPOSITORY);
          assert.equal(observedAt, OBSERVED_AT);
          return {
            scope: {} as never,
            classicScope: {} as never,
            branchMetadataScope: {} as never,
            provider,
            activeBranchRulesReader: {} as never,
            classicBranchProtectionReader: {} as never,
            branchPolicyReader,
          };
        },
      }),
      reconcile: async (input) => {
        reconcileCalls += 1;
        assert.equal(input.repository, REPOSITORY);
        assert.equal(input.issueNumber, 4);
        assert.equal(input.pullNumber, 3);
        assert.equal(input.observedAt, OBSERVED_AT);
        assert.equal(input.commitStatusCoverage, "NOT_REQUESTED");
        assert.equal(input.deployImpact, "UNKNOWN");
        assert.equal(input.provider, provider);
        assert.equal(input.branchPolicyReader, branchPolicyReader);
        return projectedResult;
      },
    },
  );

  assert.deepEqual(result, projectedResult);
  assert.equal(elevatedContextCalls, 1);
  assert.equal(reconcileCalls, 1);
});

test("preflight projects bounded REST and GraphQL read failures", async () => {
  await expectDiagnostic(
    new GitHubRestReadError("FORBIDDEN", { status: 403 }),
    502,
    { error: "GITHUB_FORBIDDEN" },
  );
  await expectDiagnostic(
    new GitHubRestReadError("CREDENTIAL_UNAVAILABLE"),
    503,
    { error: "GITHUB_CREDENTIAL_UNAVAILABLE" },
  );
  await expectDiagnostic(
    new GitHubGraphqlMergeStateError("UNAUTHORIZED", { status: 401 }),
    502,
    { error: "GITHUB_UNAUTHORIZED" },
  );
  await expectDiagnostic(
    new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE", { status: 200 }),
    502,
    { error: "GITHUB_RESPONSE_INVALID" },
  );
});

test("preflight preserves bounded transport stage and unexpected upstream status", async () => {
  await expectDiagnostic(
    new GitHubTransportStageDiagnosticError("token-exchange"),
    502,
    { error: "GITHUB_TRANSPORT_FAILED", stage: "token-exchange" },
  );
  await expectDiagnostic(
    new GitHubRestReadError("TRANSPORT_FAILURE"),
    502,
    { error: "GITHUB_TRANSPORT_FAILED", stage: "rest" },
  );
  await expectDiagnostic(
    new GitHubGraphqlMergeStateError("TRANSPORT_FAILURE"),
    502,
    { error: "GITHUB_TRANSPORT_FAILED", stage: "graphql" },
  );
  await expectDiagnostic(
    new GitHubRestReadError("UNEXPECTED_STATUS", { status: 502 }),
    502,
    { error: "GITHUB_UNEXPECTED_STATUS", stage: "rest", upstreamStatus: 502 },
  );
  await expectDiagnostic(
    new GitHubGraphqlMergeStateError("UNEXPECTED_STATUS", { status: 600 }),
    502,
    { error: "GITHUB_UNEXPECTED_STATUS", stage: "graphql" },
  );
});

test("preflight projects bounded provider and runtime failure categories", async () => {
  await expectDiagnostic(
    new GitHubAuthoritativeReadProviderError("MALFORMED_RESPONSE"),
    502,
    { error: "GITHUB_RESPONSE_INVALID" },
  );
  await expectDiagnostic(
    new GitHubActiveBranchRulesReaderError("INVALID_REQUEST"),
    502,
    { error: "GITHUB_READ_INVALID" },
  );
  await expectDiagnostic(
    new CloudflareGitHubRuntimeError("INVALID_BINDING"),
    503,
    { error: "RUNTIME_UNAVAILABLE" },
  );
});

test("preflight distinguishes bounded Classic Branch Protection failure categories", async () => {
  await expectDiagnostic(
    new GitHubClassicBranchProtectionReaderError("READ_FAILED"),
    502,
    { error: "GITHUB_CLASSIC_PROTECTION_READ_FAILED" },
  );
  await expectDiagnostic(
    new GitHubClassicBranchProtectionReaderError("MALFORMED_RESPONSE"),
    502,
    { error: "GITHUB_RESPONSE_INVALID" },
  );
  await expectDiagnostic(
    new GitHubClassicBranchProtectionReaderError("INVALID_REQUEST"),
    502,
    { error: "GITHUB_READ_INVALID" },
  );
});

test("bounded preflight diagnostics never expose typed error metadata or arbitrary upstream payloads", async () => {
  const error = new GitHubRestReadError("UNEXPECTED_STATUS", { status: 502 });
  Object.defineProperty(error, "message", {
    value: "PRIVATE KEY jwt-token raw-upstream-body https://api.github.com/private",
  });
  Object.defineProperty(error, "responseBody", {
    value: "response-body-secret",
  });
  Object.defineProperty(error, "responseHeaders", {
    value: { authorization: "Bearer secret-token" },
  });

  const response = await projectFailure(error);
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.includes("PRIVATE KEY"), false);
  assert.equal(body.includes("jwt-token"), false);
  assert.equal(body.includes("raw-upstream-body"), false);
  assert.equal(body.includes("api.github.com"), false);
  assert.equal(body.includes("response-body-secret"), false);
  assert.equal(body.includes("secret-token"), false);
  assert.deepEqual(JSON.parse(body), {
    error: "GITHUB_UNEXPECTED_STATUS",
    stage: "rest",
    upstreamStatus: 502,
  });
});

test("preflight sanitizes unexpected failures", async () => {
  const response = await handleGitHubNeedsChangesPreflightRequest(
    validRequest(),
    bindings,
    OBSERVED_AT,
    async () => {
      throw new Error("SECRET_UPSTREAM_BODY token-should-not-leak");
    },
  );
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.equal(body.includes("SECRET_UPSTREAM_BODY"), false);
  assert.equal(body.includes("token-should-not-leak"), false);
  assert.deepEqual(JSON.parse(body), { error: "LIVE_READ_FAILED" });
});

test("source boundary keeps preflight independent from writer, D1 decision audit and mutation route", async () => {
  const [route, worker] = await Promise.all([
    readFile("src/worker/github-needs-changes-preflight-route.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
  ]);

  assert.match(route, /createRepositoryNeedsChangesReadContext/);
  assert.match(route, /reconcileAuthoritativePullRequestDecision/);
  assert.doesNotMatch(route, /D1NeedsChangesDecisionAuditStore/);
  assert.doesNotMatch(route, /createGitHubPullRequestReviewWriter/);
  assert.doesNotMatch(route, /executeNeedsChangesDecision/);
  assert.doesNotMatch(route, /requestId|review body/i);
  assert.match(worker, /GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH/);
  assert.match(worker, /CONTROL_LIVE_READ_ENABLED/);
  assert.ok(worker.indexOf("GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH") < worker.indexOf("GITHUB_NEEDS_CHANGES_ROUTE_PATH"));

  void MAIN_SHA;
  void HEAD_SHA;
});
