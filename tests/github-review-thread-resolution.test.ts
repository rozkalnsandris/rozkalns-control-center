import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileAuthoritativePullRequestDecision,
  type BranchPolicyEvidenceReader,
} from "../src/shared/authoritative-reconciliation.js";
import {
  deriveProjectionPolicies,
  type BranchPolicyEvidence,
} from "../src/shared/github-policy-evidence.js";
import type { SourceControlReadProvider } from "../src/shared/source-control-read.js";
import {
  parseGitHubInstallationReadScope,
  type GitHubCredentialLeaseEvidence,
} from "../src/integrations/github/app-installation-read-contract.js";
import {
  GitHubGraphqlMergeStateError,
  createGitHubGraphqlMergeStateTransport,
  type GitHubInstallationAuthorizedGraphqlQuerySessionProvider,
} from "../src/integrations/github/graphql-merge-state-transport.js";

const repository = "rozkalnsandris/hermes-tech";
const observedAt = "2026-08-26T06:30:00.000Z";
const headSha = "1111111111111111111111111111111111111111";
const mainSha = "2222222222222222222222222222222222222222";

function scope() {
  return parseGitHubInstallationReadScope({
    installationId: 321,
    repositories: [repository],
    permissions: { pull_requests: "read" },
  });
}

function lease(): GitHubCredentialLeaseEvidence {
  return {
    installationId: 321,
    repositories: [repository],
    permissions: { pull_requests: "read" },
    issuedAt: observedAt,
    expiresAt: "2026-08-26T07:30:00.000Z",
  };
}

function response(reviewThreads: unknown): Response {
  return Response.json({
    data: {
      repository: {
        pullRequest: {
          number: 42,
          headRefOid: headSha,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          isDraft: false,
          reviewThreads,
        },
      },
    },
  });
}

function sessionProvider(reviewThreads: unknown): GitHubInstallationAuthorizedGraphqlQuerySessionProvider {
  return async () => ({
    credentialLease: lease(),
    async execute() {
      return response(reviewThreads);
    },
  });
}

function completePolicy(): BranchPolicyEvidence {
  return {
    repository,
    branch: "main",
    observedAt,
    coverage: "COMPLETE",
    sources: ["GITHUB_ACTIVE_RULES", "GITHUB_CLASSIC_BRANCH_PROTECTION"],
    requiredStatusChecks: [],
    hasUnresolvedRequiredCheckSourceIdentity: false,
    requiredApprovals: 0,
    reviewFeatures: {
      dismissStaleReviewsOnPush: false,
      requireCodeOwnerReview: false,
      requireLastPushApproval: false,
      requireReviewThreadResolution: true,
      hasRequiredFilePatternReviewers: false,
    },
  };
}

test("GraphQL merge-state read emits complete bounded review-thread resolution evidence", async () => {
  const transport = createGitHubGraphqlMergeStateTransport(
    sessionProvider({
      totalCount: 2,
      nodes: [
        { id: "PRRT_resolved", isResolved: true },
        { id: "PRRT_unresolved", isResolved: false },
      ],
      pageInfo: { hasNextPage: false },
    }),
  );

  const result = await transport.read(scope(), { repository, pullNumber: 42 }, observedAt);
  assert.deepEqual(result.mergeState.reviewThreadResolution, {
    coverage: "COMPLETE",
    totalCount: 2,
    unresolvedCount: 1,
  });
});

test("GraphQL review-thread evidence fails closed when the fixed 100-node budget is incomplete", async () => {
  const transport = createGitHubGraphqlMergeStateTransport(
    sessionProvider({
      totalCount: 101,
      nodes: [],
      pageInfo: { hasNextPage: true },
    }),
  );

  await assert.rejects(
    () => transport.read(scope(), { repository, pullNumber: 42 }, observedAt),
    (error) => error instanceof GitHubGraphqlMergeStateError && error.code === "PAGINATION_BUDGET_EXHAUSTED",
  );
});

test("GraphQL review-thread evidence rejects malformed or internally inconsistent connection data", async () => {
  for (const reviewThreads of [
    { totalCount: 1, nodes: [], pageInfo: { hasNextPage: false } },
    { totalCount: 1, nodes: [{ id: "thread", isResolved: "yes" }], pageInfo: { hasNextPage: false } },
    {
      totalCount: 2,
      nodes: [
        { id: "same", isResolved: true },
        { id: "same", isResolved: true },
      ],
      pageInfo: { hasNextPage: false },
    },
  ]) {
    const transport = createGitHubGraphqlMergeStateTransport(sessionProvider(reviewThreads));
    await assert.rejects(
      () => transport.read(scope(), { repository, pullNumber: 42 }, observedAt),
      (error) => error instanceof GitHubGraphqlMergeStateError && error.code === "MALFORMED_RESPONSE",
    );
  }
});

test("thread-resolution policy stays blocked without evidence or with unresolved threads and opens only on complete zero-unresolved evidence", () => {
  const policy = completePolicy();

  assert.deepEqual(deriveProjectionPolicies(policy).blockedReasons, ["REVIEW_THREAD_RESOLUTION_NOT_MODELED"]);
  assert.deepEqual(
    deriveProjectionPolicies(policy, { coverage: "COMPLETE", totalCount: 2, unresolvedCount: 1 }).blockedReasons,
    ["REVIEW_THREAD_RESOLUTION_UNSATISFIED"],
  );

  const resolved = deriveProjectionPolicies(policy, { coverage: "COMPLETE", totalCount: 2, unresolvedCount: 0 });
  assert.deepEqual(resolved.blockedReasons, []);
  assert.deepEqual(resolved.ciPolicy, { requiredChecks: [], requiredWorkflowNames: [] });
  assert.deepEqual(resolved.reviewPolicy, { requiredApprovals: 0 });
});

function policyReader(): BranchPolicyEvidenceReader {
  return {
    async readBranchPolicyEvidence() {
      return completePolicy();
    },
  };
}

function provider(unresolvedCount: number): SourceControlReadProvider {
  return {
    async getRepository() {
      return { repository, defaultBranch: "main" };
    },
    async getDefaultBranchHead() {
      return mainSha;
    },
    async listOpenIssues() {
      return [{ number: 5, title: "Genuine issue", state: "open", htmlUrl: `https://github.com/${repository}/issues/5` }];
    },
    async listOpenPullRequests() {
      return [];
    },
    async getPullRequest() {
      return {
        number: 42,
        title: "Review-thread evidence",
        state: "open",
        draft: false,
        baseRef: "main",
        baseSha: mainSha,
        headRef: "feat/review-threads",
        headSha,
        changedFiles: 1,
        htmlUrl: `https://github.com/${repository}/pull/42`,
      };
    },
    async getPullRequestMergeState() {
      return {
        pullNumber: 42,
        headSha,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        draft: false,
        reviewThreadResolution: { coverage: "COMPLETE", totalCount: unresolvedCount, unresolvedCount },
      };
    },
    async listPullRequestReviews() {
      return [];
    },
    async listCheckRuns() {
      return [];
    },
    async listCommitStatuses() {
      return [];
    },
    async listWorkflowRuns() {
      return [];
    },
  };
}

test("authoritative reconciliation consumes exact-head thread evidence before deriving a projection", async () => {
  const projected = await reconcileAuthoritativePullRequestDecision({
    provider: provider(0),
    branchPolicyReader: policyReader(),
    repository,
    issueNumber: 5,
    pullNumber: 42,
    observedAt,
  });
  assert.equal(projected.kind, "PROJECTED");
  if (projected.kind === "PROJECTED") {
    assert.equal(projected.decision.workflowState, "MERGE_READY");
  }

  const blocked = await reconcileAuthoritativePullRequestDecision({
    provider: provider(1),
    branchPolicyReader: policyReader(),
    repository,
    issueNumber: 5,
    pullNumber: 42,
    observedAt,
  });
  assert.equal(blocked.kind, "BLOCKED");
  if (blocked.kind === "BLOCKED") {
    assert.deepEqual(blocked.policy.blockedReasons, [
      "REVIEW_THREAD_RESOLUTION_UNSATISFIED",
      "PROJECTION_POLICY_UNAVAILABLE",
    ]);
  }
});
