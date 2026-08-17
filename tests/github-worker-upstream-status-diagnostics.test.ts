import assert from "node:assert/strict";
import test from "node:test";

import { GitHubGraphqlMergeStateError } from "../src/integrations/github/graphql-merge-state-transport.js";
import { GitHubRestReadError } from "../src/integrations/github/rest-read-transport.js";
import { handleGitHubReconciliationRequest } from "../src/worker/github-reconciliation-route.js";

const REPOSITORY = "rozkalnsandris/hermes-deals";
const OBSERVED_AT = "2026-08-17T19:00:00.000Z";
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

async function project(error: Error) {
  return handleGitHubReconciliationRequest(
    request(),
    bindings,
    OBSERVED_AT,
    async () => {
      throw error;
    },
  );
}

test("REST unexpected status exposes only bounded stage and upstream status", async () => {
  const response = await project(new GitHubRestReadError("UNEXPECTED_STATUS", { status: 502 }));

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "GITHUB_UNEXPECTED_STATUS",
    stage: "rest",
    upstreamStatus: 502,
  });
});

test("GraphQL unexpected status exposes only bounded stage and upstream status", async () => {
  const response = await project(new GitHubGraphqlMergeStateError("UNEXPECTED_STATUS", { status: 503 }));

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "GITHUB_UNEXPECTED_STATUS",
    stage: "graphql",
    upstreamStatus: 503,
  });
});

test("unexpected status omits invalid or unavailable upstream status", async () => {
  for (const error of [
    new GitHubRestReadError("UNEXPECTED_STATUS"),
    new GitHubRestReadError("UNEXPECTED_STATUS", { status: 99 }),
    new GitHubGraphqlMergeStateError("UNEXPECTED_STATUS", { status: 600 }),
  ]) {
    const response = await project(error);
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 502);
    assert.equal(body.error, "GITHUB_UNEXPECTED_STATUS");
    assert.equal(body.stage, error instanceof GitHubRestReadError ? "rest" : "graphql");
    assert.equal(Object.prototype.hasOwnProperty.call(body, "upstreamStatus"), false);
  }
});

test("unexpected status diagnostic never leaks arbitrary upstream metadata", async () => {
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

  const response = await project(error);
  const body = await response.text();

  assert.equal(response.status, 502);
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
