import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGitHubInstallationReadScope,
  type GitHubCredentialLeaseEvidence,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
  type GitHubReadRequest,
  type GitHubReadResult,
} from "../src/integrations/github/app-installation-read-contract.js";
import {
  GitHubClassicBranchProtectionReaderError,
  createGitHubClassicBranchProtectionReader,
} from "../src/integrations/github/classic-branch-protection-reader.js";
import { GitHubRestReadError } from "../src/integrations/github/rest-read-transport.js";

const repository = "rozkalnsandris/ops-workflows";
const observedAt = "2026-08-17T18:00:00.000Z";

function administrationScope(): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { administration: "read" },
  });
}

function contentsScope(): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { contents: "read" },
  });
}

function lease(readScope: GitHubInstallationReadScope): GitHubCredentialLeaseEvidence {
  return {
    installationId: readScope.installationId,
    repositories: readScope.repositories,
    permissions: readScope.permissions,
    issuedAt: observedAt,
    expiresAt: "2026-08-17T18:55:00.000Z",
  };
}

interface RestCall {
  readonly scope: GitHubInstallationReadScope;
  readonly request: GitHubReadRequest;
}

function success<T>(readScope: GitHubInstallationReadScope, payload: T): GitHubReadResult<T> {
  return {
    pages: [payload],
    credentialLease: lease(readScope),
    requestCount: 1,
    rateLimit: null,
  };
}

function scriptedTransport(
  handler: (
    readScope: GitHubInstallationReadScope,
    request: GitHubReadRequest,
  ) => GitHubReadResult<unknown> | Promise<GitHubReadResult<unknown>>,
): GitHubInstallationReadTransport {
  return {
    async get<T>(
      readScope: GitHubInstallationReadScope,
      request: GitHubReadRequest,
    ): Promise<GitHubReadResult<T>> {
      return (await handler(readScope, request)) as GitHubReadResult<T>;
    },
  };
}

function readerError(code: GitHubClassicBranchProtectionReaderError["code"]) {
  return (error: unknown) => error instanceof GitHubClassicBranchProtectionReaderError && error.code === code;
}

function classicPayload() {
  return {
    required_status_checks: {
      checks: [{ context: "CI", app_id: 15368 }],
      contexts: ["CI"],
    },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
    },
    required_conversation_resolution: { enabled: false },
  };
}

function readerWithTransport(restTransport: GitHubInstallationReadTransport) {
  return createGitHubClassicBranchProtectionReader({
    scope: administrationScope(),
    absenceScope: contentsScope(),
    observedAt,
    restTransport,
  });
}

test("reads classic protection through the exact Administration-read endpoint without fallback", async () => {
  const calls: RestCall[] = [];
  const reader = readerWithTransport(scriptedTransport((readScope, request) => {
    calls.push({ scope: readScope, request });
    return success(readScope, classicPayload());
  }));

  const observation = await reader.readClassicBranchProtection(repository, "main");

  assert.equal(observation.source, "GITHUB_CLASSIC_BRANCH_PROTECTION");
  assert.equal(observation.classicProtectionState, "PRESENT");
  assert.deepEqual(observation.requiredStatusChecks, [{ context: "CI", integrationId: 15368 }]);
  assert.equal(observation.requiredApprovals, 1);
  assert.deepEqual(calls.map(({ request }) => [request.path, request.requiredPermission]), [
    [`/repos/${repository}/branches/main/protection`, "administration"],
  ]);
});

test("requires exact Administration and bounded Contents fallback scopes before transport", () => {
  const metadataOnly = parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { metadata: "read" },
  });
  const broadFallback = parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { contents: "read", metadata: "read" },
  });
  let calls = 0;
  const transport = scriptedTransport(() => {
    calls += 1;
    throw new Error("must not run");
  });

  assert.throws(
    () => createGitHubClassicBranchProtectionReader({
      scope: metadataOnly,
      absenceScope: contentsScope(),
      observedAt,
      restTransport: transport,
    }),
    readerError("INVALID_REQUEST"),
  );
  assert.throws(
    () => createGitHubClassicBranchProtectionReader({
      scope: administrationScope(),
      absenceScope: broadFallback,
      observedAt,
      restTransport: transport,
    }),
    readerError("INVALID_REQUEST"),
  );
  assert.equal(calls, 0);
});

test("classic 404 alone is insufficient but exact unprotected branch metadata proves absence", async () => {
  const calls: RestCall[] = [];
  const reader = readerWithTransport(scriptedTransport((readScope, request) => {
    calls.push({ scope: readScope, request });
    if (request.path.endsWith("/protection")) {
      throw new GitHubRestReadError("NOT_FOUND", { status: 404 });
    }
    return success(readScope, {
      name: "main",
      protected: false,
      protection: { enabled: false },
    });
  }));

  const observation = await reader.readClassicBranchProtection(repository, "main");

  assert.equal(observation.classicProtectionState, "ABSENT");
  assert.deepEqual(observation.requiredStatusChecks, []);
  assert.equal(observation.requiredApprovals, 0);
  assert.equal(observation.hasUnresolvedRequiredCheckSourceIdentity, false);
  assert.deepEqual(calls.map(({ scope, request }) => [scope.permissions, request.path, request.requiredPermission]), [
    [{ administration: "read" }, `/repos/${repository}/branches/main/protection`, "administration"],
    [{ contents: "read" }, `/repos/${repository}/branches/main`, "contents"],
  ]);
});

test("classic 404 fallback fails closed when branch is protected or branch identity is wrong", async () => {
  for (const payload of [
    { name: "main", protected: true, protection: { enabled: true } },
    { name: "other", protected: false, protection: { enabled: false } },
  ]) {
    const reader = readerWithTransport(scriptedTransport((readScope, request) => {
      if (request.path.endsWith("/protection")) {
        throw new GitHubRestReadError("NOT_FOUND", { status: 404 });
      }
      return success(readScope, payload);
    }));
    await assert.rejects(
      () => reader.readClassicBranchProtection(repository, "main"),
      payload.name === "main" ? readerError("READ_FAILED") : readerError("MALFORMED_RESPONSE"),
    );
  }
});

test("classic 404 fallback fails closed for missing or malformed branch metadata", async () => {
  const missingBranch = readerWithTransport(scriptedTransport((_readScope, request) => {
    if (request.path.endsWith("/protection")) {
      throw new GitHubRestReadError("NOT_FOUND", { status: 404 });
    }
    throw new GitHubRestReadError("NOT_FOUND", { status: 404 });
  }));
  await assert.rejects(
    () => missingBranch.readClassicBranchProtection(repository, "main"),
    readerError("READ_FAILED"),
  );

  for (const payload of [
    { name: "main" },
    { name: "main", protected: "false" },
    { name: "main", protected: false, protection: { enabled: "false" } },
  ]) {
    const malformedBranch = readerWithTransport(scriptedTransport((readScope, request) => {
      if (request.path.endsWith("/protection")) {
        throw new GitHubRestReadError("NOT_FOUND", { status: 404 });
      }
      return success(readScope, payload);
    }));
    await assert.rejects(
      () => malformedBranch.readClassicBranchProtection(repository, "main"),
      readerError("MALFORMED_RESPONSE"),
    );
  }
});

test("non-404 classic failures preserve bounded transport diagnostics and never enter the absence fallback", async () => {
  for (const error of [
    new GitHubRestReadError("FORBIDDEN", { status: 403 }),
    new GitHubRestReadError("INVALID_REQUEST", { status: 422 }),
    new GitHubRestReadError("TRANSPORT_FAILURE"),
    new Error("ambiguous failure text"),
  ]) {
    let calls = 0;
    const reader = readerWithTransport(scriptedTransport(() => {
      calls += 1;
      throw error;
    }));
    await assert.rejects(
      () => reader.readClassicBranchProtection(repository, "main"),
      (observed) => observed === error,
    );
    assert.equal(calls, 1);
  }
});

test("fails closed for malformed classic protection payloads", async () => {
  const reader = readerWithTransport(scriptedTransport((readScope) =>
    success(readScope, { required_status_checks: {} }),
  ));

  await assert.rejects(
    () => reader.readClassicBranchProtection(repository, "main"),
    readerError("MALFORMED_RESPONSE"),
  );
});
