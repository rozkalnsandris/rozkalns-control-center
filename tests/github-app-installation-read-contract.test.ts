import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_REST_API_VERSION,
  assertGitHubCredentialLeaseUsable,
  createGitHubReadRequest,
  parseGitHubCredentialLeaseEvidence,
  parseGitHubInstallationReadScope,
} from "../src/integrations/github/app-installation-read-contract.js";

const validScopeInput = {
  installationId: 123,
  repositories: ["rozkalnsandris/hermes-tech", "rozkalnsandris/RPi5_main"],
  permissions: {
    metadata: "read",
    pull_requests: "read",
    checks: "read",
  },
};

function validLeaseInput() {
  return {
    installationId: 123,
    repositories: ["rozkalnsandris/hermes-tech", "rozkalnsandris/RPi5_main"],
    permissions: {
      metadata: "read",
      pull_requests: "read",
      checks: "read",
    },
    issuedAt: "2026-08-11T07:00:00.000Z",
    expiresAt: "2026-08-11T08:00:00.000Z",
  };
}

test("normalizes a selected managed-repository read-only scope", () => {
  const scope = parseGitHubInstallationReadScope(validScopeInput);

  assert.equal(scope.installationId, 123);
  assert.deepEqual(scope.repositories, ["rozkalnsandris/hermes-tech", "rozkalnsandris/RPi5_main"]);
  assert.equal(scope.permissions.pull_requests, "read");
});

test("rejects unmanaged and explicitly excluded repository scopes", () => {
  assert.throws(
    () => parseGitHubInstallationReadScope({ ...validScopeInput, repositories: ["rozkalnsandris/not-managed"] }),
    /not enabled for Rozkalns Control reads/,
  );
  assert.throws(
    () => parseGitHubInstallationReadScope({ ...validScopeInput, repositories: ["rozkalnsandris/hermes-email-skill"] }),
    /not enabled for Rozkalns Control reads/,
  );
});

test("rejects duplicate repository scope case-insensitively", () => {
  assert.throws(
    () => parseGitHubInstallationReadScope({
      ...validScopeInput,
      repositories: ["rozkalnsandris/hermes-tech", "RozkalnsAndris/HERMES-TECH"],
    }),
    /Duplicate GitHub installation repository scope/,
  );
});

test("keeps Administration read explicit while rejecting writes and unsupported permissions", () => {
  assert.throws(
    () => parseGitHubInstallationReadScope({ ...validScopeInput, permissions: { pull_requests: "write" } }),
    /must remain read-only/,
  );

  const administration = parseGitHubInstallationReadScope({
    installationId: 123,
    repositories: ["rozkalnsandris/hermes-tech"],
    permissions: { administration: "read" },
  });
  assert.deepEqual(administration.permissions, { administration: "read" });

  assert.throws(
    () => parseGitHubInstallationReadScope({ ...validScopeInput, permissions: { members: "read" } }),
    /not approved for Control reads/,
  );
});

test("rejects unknown scope fields and malformed installation ids", () => {
  assert.throws(
    () => parseGitHubInstallationReadScope({ ...validScopeInput, token: "secret" }),
    /unsupported field: token/,
  );
  assert.throws(
    () => parseGitHubInstallationReadScope({ ...validScopeInput, installationId: 0 }),
    /positive safe integer/,
  );
});

test("credential lease evidence is secret-free and bounded to a short lifetime", () => {
  const lease = parseGitHubCredentialLeaseEvidence(validLeaseInput());

  assert.equal(lease.expiresAt, "2026-08-11T08:00:00.000Z");
  assert.equal(JSON.stringify(lease).includes("secret"), false);

  assert.throws(
    () => parseGitHubCredentialLeaseEvidence({ ...validLeaseInput(), token: "not-allowed" }),
    /unsupported field: token/,
  );
  assert.throws(
    () => parseGitHubCredentialLeaseEvidence({ ...validLeaseInput(), expiresAt: "2026-08-11T09:00:00.000Z" }),
    /lifetime exceeds/,
  );
});

test("credential lease must match requested scope and have safe remaining lifetime", () => {
  const scope = parseGitHubInstallationReadScope(validScopeInput);
  const lease = parseGitHubCredentialLeaseEvidence(validLeaseInput());

  assert.doesNotThrow(() => assertGitHubCredentialLeaseUsable(lease, scope, "2026-08-11T07:30:00.000Z"));
  assert.throws(
    () => assertGitHubCredentialLeaseUsable(lease, scope, "2026-08-11T07:59:30.000Z"),
    /insufficient remaining lifetime/,
  );

  const otherScope = parseGitHubInstallationReadScope({
    ...validScopeInput,
    repositories: ["rozkalnsandris/hermes-tech"],
  });
  assert.throws(
    () => assertGitHubCredentialLeaseUsable(lease, otherScope, "2026-08-11T07:30:00.000Z"),
    /repository scope does not match/,
  );
});

test("read request is repository-bound, permission-bound and versioned", () => {
  const scope = parseGitHubInstallationReadScope(validScopeInput);
  const request = createGitHubReadRequest(
    scope,
    "rozkalnsandris/hermes-tech",
    "/repos/rozkalnsandris/hermes-tech/pulls/42",
    "pull_requests",
  );

  assert.equal(request.apiVersion, GITHUB_REST_API_VERSION);
  assert.equal(request.apiVersion, "2026-03-10");
  assert.equal(request.repository, "rozkalnsandris/hermes-tech");

  assert.throws(
    () => createGitHubReadRequest(
      scope,
      "rozkalnsandris/hermes-tech",
      "/repos/rozkalnsandris/hermes-deals/pulls/42",
      "pull_requests",
    ),
    /path repository does not match/,
  );
  assert.throws(
    () => createGitHubReadRequest(
      scope,
      "rozkalnsandris/hermes-tech",
      "/repos/rozkalnsandris/hermes-tech/actions/runs",
      "actions",
    ),
    /permission is outside/,
  );
  assert.throws(
    () => createGitHubReadRequest(
      scope,
      "rozkalnsandris/hermes-tech",
      "https://api.example.invalid/repos/rozkalnsandris/hermes-tech",
      "metadata",
    ),
    /relative REST path/,
  );
});
