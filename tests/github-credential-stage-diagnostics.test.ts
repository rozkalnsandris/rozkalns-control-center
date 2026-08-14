import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createGitHubReadRequest,
  parseGitHubInstallationReadScope,
} from "../src/integrations/github/app-installation-read-contract.js";
import { GitHubAppSessionError } from "../src/integrations/github/app-installation-session.js";
import {
  createGitHubCredentialDiagnosticGraphqlTransport,
  createGitHubCredentialDiagnosticRestTransport,
} from "../src/integrations/github/credential-stage-diagnostics.js";
import { GitHubGraphqlMergeStateError } from "../src/integrations/github/graphql-merge-state-transport.js";
import { GitHubRestReadError } from "../src/integrations/github/rest-read-transport.js";

const observedAt = "2026-08-14T21:55:00.000Z";
const repository = "rozkalnsandris/hermes-tech";

const scope = parseGitHubInstallationReadScope({
  installationId: 153121564,
  repositories: [repository],
  permissions: {
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    checks: "read",
    actions: "read",
  },
});

const restRequest = createGitHubReadRequest(
  scope,
  repository,
  `/repos/${repository}/pulls/1`,
  "pull_requests",
);

async function expectRestCode(
  sessionError: unknown,
  expectedCode: string,
): Promise<void> {
  const transport = createGitHubCredentialDiagnosticRestTransport(async () => {
    throw sessionError;
  });

  await assert.rejects(
    () => transport.get(scope, restRequest, observedAt),
    (error) => error instanceof GitHubRestReadError && error.code === expectedCode,
  );
}

async function expectGraphqlCode(
  sessionError: unknown,
  expectedCode: string,
): Promise<void> {
  const transport = createGitHubCredentialDiagnosticGraphqlTransport(async () => {
    throw sessionError;
  });

  await assert.rejects(
    () => transport.read(scope, { repository, pullNumber: 1 }, observedAt),
    (error) => error instanceof GitHubGraphqlMergeStateError && error.code === expectedCode,
  );
}

test("preserves bounded GitHub App credential-stage outcomes for REST and GraphQL", async () => {
  const cases = [
    [new GitHubAppSessionError("SIGNING_FAILED"), "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE"],
    [new GitHubAppSessionError("TOKEN_EXCHANGE_FAILED"), "TRANSPORT_FAILURE", "TRANSPORT_FAILURE"],
    [new GitHubAppSessionError("TOKEN_EXCHANGE_FAILED", 500), "UNEXPECTED_STATUS", "UNEXPECTED_STATUS"],
    [new GitHubAppSessionError("TOKEN_UNAUTHORIZED", 401), "UNAUTHORIZED", "UNAUTHORIZED"],
    [new GitHubAppSessionError("TOKEN_FORBIDDEN", 403), "FORBIDDEN", "FORBIDDEN"],
    [new GitHubAppSessionError("TOKEN_NOT_FOUND", 404), "NOT_FOUND", "RESOURCE_NOT_FOUND"],
    [new GitHubAppSessionError("TOKEN_SCOPE_REJECTED", 422), "INVALID_REQUEST", "INVALID_REQUEST"],
    [new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE", 201), "MALFORMED_RESPONSE", "MALFORMED_RESPONSE"],
    [new GitHubAppSessionError("TOKEN_SCOPE_MISMATCH"), "INVALID_REQUEST", "INVALID_REQUEST"],
    [new GitHubAppSessionError("TOKEN_UNUSABLE"), "CREDENTIAL_UNUSABLE", "CREDENTIAL_UNUSABLE"],
  ] as const;

  for (const [sessionError, restCode, graphqlCode] of cases) {
    await expectRestCode(sessionError, restCode);
    await expectGraphqlCode(sessionError, graphqlCode);
  }
});

test("unknown credential acquisition failures remain generic and do not expose raw details", async () => {
  const raw = "PRIVATE KEY jwt-token upstream-body";

  const restTransport = createGitHubCredentialDiagnosticRestTransport(async () => {
    throw new Error(raw);
  });
  await assert.rejects(
    () => restTransport.get(scope, restRequest, observedAt),
    (error) =>
      error instanceof GitHubRestReadError &&
      error.code === "CREDENTIAL_UNAVAILABLE" &&
      !error.message.includes(raw) &&
      !error.message.includes("PRIVATE KEY"),
  );

  const graphqlTransport = createGitHubCredentialDiagnosticGraphqlTransport(async () => {
    throw new Error(raw);
  });
  await assert.rejects(
    () => graphqlTransport.read(scope, { repository, pullNumber: 1 }, observedAt),
    (error) =>
      error instanceof GitHubGraphqlMergeStateError &&
      error.code === "CREDENTIAL_UNAVAILABLE" &&
      !error.message.includes(raw) &&
      !error.message.includes("PRIVATE KEY"),
  );
});

test("Cloudflare runtime uses credential diagnostic transports without changing bindings or signing", async () => {
  const source = await readFile("src/integrations/github/cloudflare-worker-runtime.ts", "utf8");

  assert.match(source, /createGitHubCredentialDiagnosticRestTransport\(restSessionProvider\)/);
  assert.match(source, /createGitHubCredentialDiagnosticGraphqlTransport\(graphqlSessionProvider\)/);
  assert.match(source, /signRsaSha256\("sha256", signingInput, privateKeyPem\)/);
  assert.match(source, /GITHUB_APP_PRIVATE_KEY_PEM/);
  assert.doesNotMatch(source, /console\.(?:log|error|warn).*privateKeyPem/);
});
