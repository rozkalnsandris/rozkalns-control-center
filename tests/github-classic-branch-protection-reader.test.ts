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

function classicScope(): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { metadata: "read", administration: "read" },
  });
}

function absenceScope(): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { metadata: "read", contents: "read" },
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

function restError(code: GitHubRestReadError["code"], status: number | null = null) {
  return (error: unknown) =>
    error instanceof GitHubRestReadError && error.code === code && error.status === status;
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
    scope: classicScope(),
    absenceScope: absenceScope(),
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

test("requires Administration and an exact Metadata-plus-Contents absence scope before transport", () => {
  const metadataOnly = parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { metadata: "read" },
  });
  const contentsOnly = parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { contents: "read" },
  });
  const broadFallback = parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { metadata: "read", contents: "read", issues: "read" },
  });
  let calls = 0;
  const transport = scriptedTransport(() => {
    calls += 1;
    throw new Error("must not run");
  });

  assert.throws(
    () => createGitHubClassicBranchProtectionReader({
      scope: metadataOnly,
      absenceScope: absenceScope(),
      observedAt,
      restTransport: transport,
    }),
    readerError("INVALID_REQUEST"),
  );
  assert.throws(
    () => createGitHubClassicBranchProtectionReader({
      scope: classicScope(),
      absenceScope: contentsOnly,
      observedAt,
      restTransport: transport,
    }),
    readerError("INVALID_REQUEST"),
  );
  assert.throws(
    () => createGitHubClassicBranchProtectionReader({
      scope: classicScope(),
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
    [{ metadata: "read", administration: "read" }, `/repos/${repository}/branches/main/protection`, "administration"],
    [{ metadata: "read", contents: "read" }, `/repos/${repository}/branches/main`, "contents"],
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

test("classic 404 fallback preserves a missing branch as bounded REST not-found evidence", async () => {
  const missingBranch = readerWithTransport(scriptedTransport((_readScope, request) => {
    if (request.path.endsWith("/protection")) {
      throw new GitHubRestReadError("NOT_FOUND", { status: 404 });
    }
    throw new GitHubRestReadError("NOT_FOUND", { status: 404 });
  }));

  await assert.rejects(
    () => missingBranch.readClassicBranchProtection(repository, "main"),
    restError("NOT_FOUND", 404),
  );
});

test("classic 404 fallback fails closed for malformed branch metadata", async () => {
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

test("classic 404 fallback preserves bounded transport diagnostics instead of collapsing them", async () => {
  for (const error of [
    new GitHubRestReadError("FORBIDDEN", { status: 403 }),
    new GitHubRestReadError("INVALID_REQUEST", { status: 422 }),
    new GitHubRestReadError("TRANSPORT_FAILURE"),
    new Error("ambiguous failure text"),
  ]) {
    let calls = 0;
    const reader = readerWithTransport(scriptedTransport(() => {
      calls += 1;
      if (calls === 1) throw new GitHubRestReadError("NOT_FOUND", { status: 404 });
      throw error;
    }));

    await assert.rejects(
      () => reader.readClassicBranchProtection(repository, "main"),
      (observed) => observed === error,
    );
    assert.equal(calls, 2);
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
