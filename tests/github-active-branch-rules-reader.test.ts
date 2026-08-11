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
  GitHubActiveBranchRulesReaderError,
  createGitHubActiveBranchRulesReader,
  readGitHubActiveBranchPolicyEvidence,
} from "../src/integrations/github/active-branch-rules-reader.js";
import { deriveProjectionPolicies } from "../src/shared/github-policy-evidence.js";

const repository = "rozkalnsandris/hermes-tech";
const observedAt = "2026-08-12T00:25:00.000+02:00";

function scope(permissions: Record<string, "read"> = { metadata: "read" }): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 812,
    repositories: [repository],
    permissions,
  });
}

function lease(readScope: GitHubInstallationReadScope): GitHubCredentialLeaseEvidence {
  return {
    installationId: readScope.installationId,
    repositories: readScope.repositories,
    permissions: readScope.permissions,
    issuedAt: "2026-08-11T22:20:00.000Z",
    expiresAt: "2026-08-11T23:20:00.000Z",
  };
}

interface RestCall {
  readonly request: GitHubReadRequest;
  readonly observedAt: string;
}

function fakeRestTransport(
  readScope: GitHubInstallationReadScope,
  pages: readonly unknown[],
  calls: RestCall[],
): GitHubInstallationReadTransport {
  return {
    async get<T>(
      _scope: GitHubInstallationReadScope,
      request: GitHubReadRequest,
      callObservedAt: string,
    ): Promise<GitHubReadResult<T>> {
      calls.push({ request, observedAt: callObservedAt });
      return {
        pages: pages as readonly T[],
        credentialLease: lease(readScope),
        requestCount: pages.length,
        rateLimit: null,
      };
    },
  };
}

function pullRequestRule(requiredApprovals = 1) {
  return {
    type: "pull_request",
    ruleset_source_type: "Repository",
    ruleset_source: repository,
    ruleset_id: 42,
    parameters: {
      required_approving_review_count: requiredApprovals,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: false,
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof GitHubActiveBranchRulesReaderError ? error.code : undefined;
}

test("reads paginated active branch rules with exact Metadata request and remains partial without classic protection", async () => {
  const readScope = scope();
  const calls: RestCall[] = [];
  const reader = createGitHubActiveBranchRulesReader({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(
      readScope,
      [
        [
          {
            type: "required_status_checks",
            ruleset_source_type: "Organization",
            ruleset_source: "rozkalnsandris",
            ruleset_id: 10,
            parameters: {
              required_status_checks: [{ context: "validate", integration_id: 15368 }],
              strict_required_status_checks_policy: true,
            },
          },
        ],
        [pullRequestRule(2), { type: "non_fast_forward" }],
      ],
      calls,
    ),
  });

  const observation = await reader.readActiveBranchRules(repository, "main");
  assert.equal(observation.source, "GITHUB_ACTIVE_RULES");
  assert.equal(observation.repository, repository);
  assert.equal(observation.branch, "main");
  assert.equal(observation.observedAt, observedAt);
  assert.deepEqual(observation.requiredStatusChecks, [{ context: "validate", integrationId: 15368 }]);
  assert.equal(observation.requiredApprovals, 2);

  assert.deepEqual(calls, [
    {
      request: {
        repository,
        path: `/repos/${repository}/rules/branches/main?per_page=100`,
        requiredPermission: "metadata",
        apiVersion: "2026-03-10",
      },
      observedAt,
    },
  ]);

  const evidenceCalls: RestCall[] = [];
  const evidence = await readGitHubActiveBranchPolicyEvidence({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(readScope, [[pullRequestRule()]], evidenceCalls),
    repository,
    branch: "main",
  });

  assert.equal(evidence.coverage, "PARTIAL");
  assert.deepEqual(evidence.sources, ["GITHUB_ACTIVE_RULES"]);
  assert.equal(evidence.observedAt, observedAt);
  assert.deepEqual(deriveProjectionPolicies(evidence), {
    blockedReasons: ["BRANCH_POLICY_COVERAGE_INCOMPLETE"],
  });
  assert.equal(evidenceCalls[0]?.observedAt, observedAt);
});

test("path-segment encodes branch names without changing the mapped branch identity", async () => {
  const readScope = scope();
  const calls: RestCall[] = [];
  const reader = createGitHubActiveBranchRulesReader({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(readScope, [[]], calls),
  });

  const observation = await reader.readActiveBranchRules(repository, "release/2026.08");
  assert.equal(observation.branch, "release/2026.08");
  assert.equal(calls[0]?.request.path, `/repos/${repository}/rules/branches/release%2F2026.08?per_page=100`);
  assert.equal(calls[0]?.request.requiredPermission, "metadata");
  assert.equal(calls[0]?.observedAt, observedAt);
});

test("missing Metadata permission fails before the REST transport executes", async () => {
  const readScope = scope({ contents: "read" });
  let calls = 0;
  const reader = createGitHubActiveBranchRulesReader({
    scope: readScope,
    observedAt,
    restTransport: {
      async get<T>(): Promise<GitHubReadResult<T>> {
        calls += 1;
        throw new Error("must not execute");
      },
    },
  });

  await assert.rejects(
    () => reader.readActiveBranchRules(repository, "main"),
    (error) => errorCode(error) === "INVALID_REQUEST",
  );
  assert.equal(calls, 0);
});

test("rejects invalid observation time, unmanaged repositories and unsafe branch input", async () => {
  const readScope = scope();
  assert.throws(
    () =>
      createGitHubActiveBranchRulesReader({
        scope: readScope,
        observedAt: "not-a-time",
        restTransport: fakeRestTransport(readScope, [[]], []),
      }),
    (error) => errorCode(error) === "INVALID_REQUEST",
  );

  const reader = createGitHubActiveBranchRulesReader({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(readScope, [[]], []),
  });

  await assert.rejects(
    () => reader.readActiveBranchRules("rozkalnsandris/not-managed", "main"),
    (error) => errorCode(error) === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => reader.readActiveBranchRules(repository, "   "),
    (error) => errorCode(error) === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => reader.readActiveBranchRules(repository, "main\nother"),
    (error) => errorCode(error) === "INVALID_REQUEST",
  );
});

test("fails closed on malformed pagination pages and malformed consumed rule fields", async () => {
  const readScope = scope();

  const malformedPage = createGitHubActiveBranchRulesReader({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(readScope, [{ not: "an array" }], []),
  });
  await assert.rejects(
    () => malformedPage.readActiveBranchRules(repository, "main"),
    (error) => errorCode(error) === "MALFORMED_RESPONSE",
  );

  const malformedRule = createGitHubActiveBranchRulesReader({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(readScope, [[pullRequestRule(-1)]], []),
  });
  await assert.rejects(
    () => malformedRule.readActiveBranchRules(repository, "main"),
    (error) => errorCode(error) === "MALFORMED_RESPONSE",
  );
});
