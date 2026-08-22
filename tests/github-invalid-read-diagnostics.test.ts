import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubReadRequest,
  parseGitHubInstallationReadScope,
} from "../src/integrations/github/app-installation-read-contract.js";
import { GitHubAppSessionError } from "../src/integrations/github/app-installation-session.js";
import {
  createGitHubCredentialDiagnosticGraphqlTransport,
  createGitHubCredentialDiagnosticRestTransport,
  GitHubGraphqlValidationDiagnosticError,
  GitHubRestValidationDiagnosticError,
  type GitHubValidationDiagnosticCode,
} from "../src/integrations/github/credential-stage-diagnostics.js";
import {
  GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH,
  handleGitHubNeedsChangesPreflightRequest,
} from "../src/worker/github-needs-changes-preflight-route.js";

const observedAt = "2026-08-22T16:35:17.000Z";
const repository = "rozkalnsandris/hermes-tech";
const preflightRepository = "rozkalnsandris/ops-workflows";

const scope = parseGitHubInstallationReadScope({
  installationId: 153121564,
  repositories: [repository],
  permissions: {
    metadata: "read",
    contents: "read",
    pull_requests: "read",
  },
});

const restRequest = createGitHubReadRequest(
  scope,
  repository,
  `/repos/${repository}/pulls/1`,
  "pull_requests",
);

const bindings = {
  GITHUB_APP_PRIVATE_KEY_PEM: "test-only-not-used",
  GITHUB_APP_CLIENT_ID: "test-client",
  GITHUB_APP_INSTALLATION_ID: "1",
};

const diagnosticCases = [
  ["TOKEN_SCOPE_REJECTED", "GITHUB_TOKEN_SCOPE_REJECTED"],
  ["TOKEN_SCOPE_MISMATCH", "GITHUB_TOKEN_SCOPE_MISMATCH"],
  ["READ_REQUEST_INVALID", "GITHUB_REST_REQUEST_INVALID"],
  ["GRAPHQL_REQUEST_INVALID", "GITHUB_GRAPHQL_REQUEST_INVALID"],
] as const satisfies readonly (readonly [GitHubValidationDiagnosticCode, string])[];

test("credential diagnostic transports preserve bounded validation causes without upstream details", async () => {
  for (const [code] of diagnosticCases) {
    const restTransport = createGitHubCredentialDiagnosticRestTransport(async () => {
      throw new GitHubAppSessionError(code, 422);
    });
    await assert.rejects(
      () => restTransport.get(scope, restRequest, observedAt),
      (error) =>
        error instanceof GitHubRestValidationDiagnosticError &&
        error.code === "INVALID_REQUEST" &&
        error.diagnosticCode === code &&
        error.status === null &&
        !error.message.includes("422"),
    );

    const graphqlTransport = createGitHubCredentialDiagnosticGraphqlTransport(async () => {
      throw new GitHubAppSessionError(code, 422);
    });
    await assert.rejects(
      () => graphqlTransport.read(scope, { repository, pullNumber: 1 }, observedAt),
      (error) =>
        error instanceof GitHubGraphqlValidationDiagnosticError &&
        error.code === "INVALID_REQUEST" &&
        error.diagnosticCode === code &&
        error.status === null &&
        !error.message.includes("422"),
    );
  }
});

test("Needs changes preflight maps each validation cause to one bounded error code", async () => {
  for (const [code, routeCode] of diagnosticCases) {
    const diagnostic =
      code === "GRAPHQL_REQUEST_INVALID"
        ? new GitHubGraphqlValidationDiagnosticError(code)
        : new GitHubRestValidationDiagnosticError(code);

    const request = new Request(
      `https://control.invalid${GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH}?repository=${encodeURIComponent(preflightRepository)}&issue=4&pull=3`,
    );
    const response = await handleGitHubNeedsChangesPreflightRequest(
      request,
      bindings,
      observedAt,
      async () => {
        throw diagnostic;
      },
    );

    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: routeCode });
  }
});

test("validation diagnostics never expose arbitrary exception metadata", async () => {
  const error = new GitHubRestValidationDiagnosticError("TOKEN_SCOPE_MISMATCH");
  Object.defineProperty(error, "message", {
    value: "PRIVATE KEY jwt-token raw-upstream-body https://api.github.com/private",
  });
  Object.defineProperty(error, "responseBody", {
    value: "response-body-secret",
  });
  Object.defineProperty(error, "responseHeaders", {
    value: { authorization: "Bearer secret-token" },
  });

  const request = new Request(
    `https://control.invalid${GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH}?repository=${encodeURIComponent(preflightRepository)}&issue=4&pull=3`,
  );
  const response = await handleGitHubNeedsChangesPreflightRequest(
    request,
    bindings,
    observedAt,
    async () => {
      throw error;
    },
  );
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.includes("PRIVATE KEY"), false);
  assert.equal(body.includes("jwt-token"), false);
  assert.equal(body.includes("raw-upstream-body"), false);
  assert.equal(body.includes("api.github.com"), false);
  assert.equal(body.includes("response-body-secret"), false);
  assert.equal(body.includes("secret-token"), false);
  assert.deepEqual(JSON.parse(body), { error: "GITHUB_TOKEN_SCOPE_MISMATCH" });
});
