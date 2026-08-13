import assert from "node:assert/strict";
import test from "node:test";

import type { AuthoritativeReconciliationResult } from "../src/shared/authoritative-reconciliation.js";
import {
  executeLiveGitHubReconciliation,
  handleGitHubReconciliationRequest,
  type LiveGitHubReconciliationInput,
} from "../src/worker/github-reconciliation-route.js";

const REPOSITORY = "rozkalnsandris/hermes-deals";
const OBSERVED_AT = "2026-08-13T10:50:00.000Z";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";

const bindings = {
  GITHUB_APP_PRIVATE_KEY_PEM: "test-only-not-used",
  GITHUB_APP_CLIENT_ID: "test-client",
  GITHUB_APP_INSTALLATION_ID: "1",
};

const blockedResult = {
  kind: "BLOCKED",
  repository: REPOSITORY,
  issueNumber: 49,
  pullNumber: 625,
  observedAt: OBSERVED_AT,
  defaultBranch: "main",
  mainSha: MAIN_SHA,
  headSha: HEAD_SHA,
  commitStatusCoverage: "NOT_REQUESTED",
  policy: {
    coverage: "PARTIAL",
    sources: ["GITHUB_ACTIVE_RULES"],
    blockedReasons: ["BRANCH_POLICY_COVERAGE_INCOMPLETE"],
  },
} as const satisfies AuthoritativeReconciliationResult;

function request(query: string, method = "GET") {
  return new Request(`https://control.invalid/api/github/reconcile?${query}`, { method });
}

test("read-only route returns only normalized reconciliation output with no-store caching", async () => {
  let captured: LiveGitHubReconciliationInput | null = null;

  const response = await handleGitHubReconciliationRequest(
    request(`repository=${encodeURIComponent(REPOSITORY)}&issue=49&pull=625`),
    bindings,
    OBSERVED_AT,
    async (input) => {
      captured = input;
      return blockedResult;
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), blockedResult);
  assert.deepEqual(captured, {
    bindings,
    repository: REPOSITORY,
    issueNumber: 49,
    pullNumber: 625,
    observedAt: OBSERVED_AT,
  });
});

test("route fails closed before executor on malformed, duplicate, extra and unmanaged inputs", async () => {
  const invalidQueries = [
    `repository=${encodeURIComponent(REPOSITORY)}&issue=49`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=49&pull=625&extra=1`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=49&issue=50&pull=625`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=0&pull=625`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=-1&pull=625`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=1.5&pull=625`,
    `repository=${encodeURIComponent(REPOSITORY)}&issue=9007199254740992&pull=625`,
    `repository=${encodeURIComponent("rozkalnsandris/hermes-email-skill")}&issue=49&pull=625`,
    `repository=${encodeURIComponent("rozkalnsandris/unknown")}&issue=49&pull=625`,
  ];

  let calls = 0;
  for (const query of invalidQueries) {
    const response = await handleGitHubReconciliationRequest(
      request(query),
      bindings,
      OBSERVED_AT,
      async () => {
        calls += 1;
        return blockedResult;
      },
    );

    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "INVALID_REQUEST" });
  }

  assert.equal(calls, 0);
});

test("route rejects non-GET requests and unrelated paths without executing live reads", async () => {
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return blockedResult;
  };

  const postResponse = await handleGitHubReconciliationRequest(
    request(`repository=${encodeURIComponent(REPOSITORY)}&issue=49&pull=625`, "POST"),
    bindings,
    OBSERVED_AT,
    executor,
  );
  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get("allow"), "GET");
  assert.equal(postResponse.headers.get("cache-control"), "no-store");

  const unrelatedResponse = await handleGitHubReconciliationRequest(
    new Request("https://control.invalid/api/other"),
    bindings,
    OBSERVED_AT,
    executor,
  );
  assert.equal(unrelatedResponse.status, 404);
  assert.equal(unrelatedResponse.headers.get("cache-control"), "no-store");
  assert.equal(calls, 0);
});

test("route sanitizes unexpected upstream failures", async () => {
  const response = await handleGitHubReconciliationRequest(
    request(`repository=${encodeURIComponent(REPOSITORY)}&issue=49&pull=625`),
    bindings,
    OBSERVED_AT,
    async () => {
      throw new Error("SECRET_UPSTREAM_BODY token-should-not-leak");
    },
  );

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.equal(body.includes("SECRET_UPSTREAM_BODY"), false);
  assert.equal(body.includes("token-should-not-leak"), false);
  assert.deepEqual(JSON.parse(body), { error: "LIVE_READ_FAILED" });
});

test("live executor preserves one observation time and explicitly skips commit-status reads", async () => {
  let contextCalls = 0;
  let reconcileCalls = 0;

  const provider = {} as never;
  const branchPolicyReader = {} as never;

  const result = await executeLiveGitHubReconciliation(
    {
      bindings,
      repository: REPOSITORY,
      issueNumber: 49,
      pullNumber: 625,
      observedAt: OBSERVED_AT,
    },
    {
      createRuntime: () => ({
        clientId: "test-client",
        installationId: 1,
        createRepositoryReadContext(repository, observedAt) {
          contextCalls += 1;
          assert.equal(repository, REPOSITORY);
          assert.equal(observedAt, OBSERVED_AT);
          return {
            scope: {} as never,
            provider,
            activeBranchRulesReader: {} as never,
            branchPolicyReader,
          };
        },
      }),
      reconcile: async (input) => {
        reconcileCalls += 1;
        assert.equal(input.repository, REPOSITORY);
        assert.equal(input.issueNumber, 49);
        assert.equal(input.pullNumber, 625);
        assert.equal(input.observedAt, OBSERVED_AT);
        assert.equal(input.commitStatusCoverage, "NOT_REQUESTED");
        assert.equal(input.deployImpact, "UNKNOWN");
        assert.equal(input.provider, provider);
        assert.equal(input.branchPolicyReader, branchPolicyReader);
        return blockedResult;
      },
    },
  );

  assert.deepEqual(result, blockedResult);
  assert.equal(contextCalls, 1);
  assert.equal(reconcileCalls, 1);
});
