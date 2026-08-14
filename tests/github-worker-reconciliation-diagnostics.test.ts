import assert from "node:assert/strict";
import test from "node:test";

import { GitHubGraphqlMergeStateError } from "../src/integrations/github/graphql-merge-state-transport.js";
import { GitHubRestReadError } from "../src/integrations/github/rest-read-transport.js";
import { handleGitHubReconciliationRequest } from "../src/worker/github-reconciliation-route.js";

const REPOSITORY = "rozkalnsandris/hermes-deals";
const OBSERVED_AT = "2026-08-14T21:05:00.000Z";
const bindings = {
  GITHUB_APP_PRIVATE_KEY_PEM: "test-only-not-used",
  GITHUB_APP_CLIENT_ID: "test-client",
  GITHUB_APP_INSTALLATION_ID: "1",
};

function request() {
  return new Request(
    `https://control.invalid/api/github/reconcile?repository=${encodeURIComponent(REPOSITORY)}&issue=19&pull=657`,
  );
}

async function expectFailure(error: Error, status: number, code: string) {
  const response = await handleGitHubReconciliationRequest(
    request(),
    bindings,
    OBSERVED_AT,
    async () => {
      throw error;
    },
  );

  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: code });
}

test("reconciliation route projects bounded REST failure categories", async () => {
  await expectFailure(
    new GitHubRestReadError("CREDENTIAL_UNAVAILABLE"),
    503,
    "GITHUB_CREDENTIAL_UNAVAILABLE",
  );
  await expectFailure(
    new GitHubRestReadError("CREDENTIAL_UNUSABLE"),
    503,
    "GITHUB_CREDENTIAL_UNUSABLE",
  );
  await expectFailure(
    new GitHubRestReadError("UNAUTHORIZED", { status: 401 }),
    502,
    "GITHUB_UNAUTHORIZED",
  );
  await expectFailure(
    new GitHubRestReadError("FORBIDDEN", { status: 403 }),
    502,
    "GITHUB_FORBIDDEN",
  );
  await expectFailure(
    new GitHubRestReadError("RATE_LIMITED", {
      status: 429,
      retryNotBefore: "2026-08-14T21:06:00.000Z",
    }),
    503,
    "GITHUB_RATE_LIMITED",
  );
  await expectFailure(
    new GitHubRestReadError("NOT_FOUND", { status: 404 }),
    502,
    "GITHUB_RESOURCE_NOT_FOUND",
  );
  await expectFailure(
    new GitHubRestReadError("MALFORMED_RESPONSE", { status: 200 }),
    502,
    "GITHUB_RESPONSE_INVALID",
  );
  await expectFailure(
    new GitHubRestReadError("PAGINATION_BOUNDARY_VIOLATION"),
    502,
    "GITHUB_RESPONSE_INVALID",
  );
});

test("reconciliation route projects bounded GraphQL failure categories", async () => {
  await expectFailure(
    new GitHubGraphqlMergeStateError("CREDENTIAL_UNAVAILABLE"),
    503,
    "GITHUB_CREDENTIAL_UNAVAILABLE",
  );
  await expectFailure(
    new GitHubGraphqlMergeStateError("UNAUTHORIZED", { status: 401 }),
    502,
    "GITHUB_UNAUTHORIZED",
  );
  await expectFailure(
    new GitHubGraphqlMergeStateError("FORBIDDEN", { status: 403 }),
    502,
    "GITHUB_FORBIDDEN",
  );
  await expectFailure(
    new GitHubGraphqlMergeStateError("RATE_LIMITED", {
      status: 429,
      retryNotBefore: "2026-08-14T21:06:00.000Z",
    }),
    503,
    "GITHUB_RATE_LIMITED",
  );
  await expectFailure(
    new GitHubGraphqlMergeStateError("RESOURCE_NOT_FOUND"),
    502,
    "GITHUB_RESOURCE_NOT_FOUND",
  );
  await expectFailure(
    new GitHubGraphqlMergeStateError("GRAPHQL_ERROR", { status: 200 }),
    502,
    "GITHUB_GRAPHQL_FAILED",
  );
  await expectFailure(
    new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE", { status: 200 }),
    502,
    "GITHUB_RESPONSE_INVALID",
  );
});

test("diagnostic projection never exposes typed error metadata or arbitrary upstream messages", async () => {
  const rest = new GitHubRestReadError("RATE_LIMITED", {
    status: 429,
    retryNotBefore: "2026-08-14T21:06:00.000Z",
  });
  Object.defineProperty(rest, "message", {
    value: "secret-token-should-never-leak",
  });

  const response = await handleGitHubReconciliationRequest(
    request(),
    bindings,
    OBSERVED_AT,
    async () => {
      throw rest;
    },
  );

  const body = await response.text();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.includes("secret-token-should-never-leak"), false);
  assert.equal(body.includes("2026-08-14T21:06:00.000Z"), false);
  assert.equal(body.includes("429"), false);
  assert.deepEqual(JSON.parse(body), { error: "GITHUB_RATE_LIMITED" });
});
