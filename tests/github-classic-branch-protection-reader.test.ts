import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGitHubInstallationReadScope,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
  type GitHubReadRequest,
  type GitHubReadResult,
} from "../src/integrations/github/app-installation-read-contract.js";
import {
  GitHubClassicBranchProtectionReaderError,
  createGitHubClassicBranchProtectionReader,
} from "../src/integrations/github/classic-branch-protection-reader.js";

const repository = "rozkalnsandris/ops-workflows";
const observedAt = "2026-08-17T18:00:00.000Z";

function scope(): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { administration: "read" },
  });
}

function transportFor(
  readScope: GitHubInstallationReadScope,
  payload: unknown,
  calls: GitHubReadRequest[],
): GitHubInstallationReadTransport {
  return {
    async get<T>(
      _scope: GitHubInstallationReadScope,
      request: GitHubReadRequest,
    ): Promise<GitHubReadResult<T>> {
      calls.push(request);
      return {
        pages: [payload as T],
        credentialLease: {
          installationId: readScope.installationId,
          repositories: readScope.repositories,
          permissions: readScope.permissions,
          issuedAt: observedAt,
          expiresAt: "2026-08-17T18:55:00.000Z",
        },
        requestCount: 1,
        rateLimit: null,
      };
    },
  };
}

function readerError(code: GitHubClassicBranchProtectionReaderError["code"]) {
  return (error: unknown) => error instanceof GitHubClassicBranchProtectionReaderError && error.code === code;
}

test("reads classic protection through the exact Administration-read endpoint", async () => {
  const readScope = scope();
  const calls: GitHubReadRequest[] = [];
  const reader = createGitHubClassicBranchProtectionReader({
    scope: readScope,
    observedAt,
    restTransport: transportFor(
      readScope,
      {
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
      },
      calls,
    ),
  });

  const observation = await reader.readClassicBranchProtection(repository, "main");

  assert.equal(observation.source, "GITHUB_CLASSIC_BRANCH_PROTECTION");
  assert.equal(observation.repository, repository);
  assert.equal(observation.branch, "main");
  assert.equal(observation.observedAt, observedAt);
  assert.deepEqual(observation.requiredStatusChecks, [{ context: "CI", integrationId: 15368 }]);
  assert.equal(observation.requiredApprovals, 1);
  assert.deepEqual(calls.map((call) => [call.path, call.requiredPermission]), [
    [`/repos/${repository}/branches/main/protection`, "administration"],
  ]);
});

test("requires an explicit Administration read scope before transport", async () => {
  const readScope = parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { metadata: "read" },
  });
  let calls = 0;

  assert.throws(
    () => createGitHubClassicBranchProtectionReader({
      scope: readScope,
      observedAt,
      restTransport: {
        async get<T>(): Promise<GitHubReadResult<T>> {
          calls += 1;
          throw new Error("must not run");
        },
      },
    }),
    readerError("INVALID_REQUEST"),
  );
  assert.equal(calls, 0);
});

test("fails closed for ambiguous endpoint failures including 404 or permission rejection", async () => {
  const readScope = scope();
  for (const label of ["ambiguous-404", "permission-rejected"]) {
    const reader = createGitHubClassicBranchProtectionReader({
      scope: readScope,
      observedAt,
      restTransport: {
        async get<T>(): Promise<GitHubReadResult<T>> {
          throw new Error(label);
        },
      },
    });
    await assert.rejects(
      () => reader.readClassicBranchProtection(repository, "main"),
      readerError("READ_FAILED"),
      label,
    );
  }
});

test("fails closed for malformed classic protection payloads", async () => {
  const readScope = scope();
  const reader = createGitHubClassicBranchProtectionReader({
    scope: readScope,
    observedAt,
    restTransport: transportFor(readScope, { required_status_checks: {} }, []),
  });

  await assert.rejects(
    () => reader.readClassicBranchProtection(repository, "main"),
    readerError("MALFORMED_RESPONSE"),
  );
});
