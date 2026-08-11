import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthoritativeReconciliationError,
  reconcileAuthoritativePullRequestDecision,
  type BranchPolicyEvidenceReader,
} from "../src/shared/authoritative-reconciliation.js";
import {
  combineBranchPolicyObservations,
  type BranchPolicyEvidence,
  type BranchPolicyObservation,
} from "../src/shared/github-policy-evidence.js";
import type {
  CheckRunRead,
  CommitStatusRead,
  IssueRead,
  PullRequestMergeStateRead,
  PullRequestRead,
  PullRequestReviewRead,
  RepositoryRef,
  SourceControlReadProvider,
  WorkflowRunRead,
} from "../src/shared/source-control-read.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const OBSERVED_AT = "2026-08-12T00:50:00+02:00";
const HEAD = "1111111111111111111111111111111111111111";
const MAIN = "2222222222222222222222222222222222222222";
const ISSUE_NUMBER = 47;
const PULL_NUMBER = 48;

interface ProviderState {
  commitStatusCalls: number;
}

function repositoryRead(): RepositoryRef {
  return { repository: REPOSITORY, defaultBranch: "main" };
}

function issue(overrides: Partial<IssueRead> = {}): IssueRead {
  return {
    number: ISSUE_NUMBER,
    title: "Authoritative reconciliation composition",
    state: "open",
    htmlUrl: `https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
    ...overrides,
  };
}

function pull(overrides: Partial<PullRequestRead> = {}): PullRequestRead {
  return {
    number: PULL_NUMBER,
    title: "Compose authoritative reconciliation",
    state: "open",
    draft: false,
    baseRef: "main",
    baseSha: MAIN,
    headRef: "feat/reconciliation",
    headSha: HEAD,
    changedFiles: 3,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}`,
    ...overrides,
  };
}

function mergeState(overrides: Partial<PullRequestMergeStateRead> = {}): PullRequestMergeStateRead {
  return {
    pullNumber: PULL_NUMBER,
    headSha: HEAD,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    draft: false,
    ...overrides,
  };
}

function review(overrides: Partial<PullRequestReviewRead> = {}): PullRequestReviewRead {
  return {
    id: "review-1",
    state: "APPROVED",
    actor: "reviewer",
    submittedAt: "2026-08-11T22:40:00Z",
    ...overrides,
  };
}

function check(overrides: Partial<CheckRunRead> = {}): CheckRunRead {
  return {
    id: "check-1",
    name: "validate",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    appId: null,
    detailsUrl: null,
    ...overrides,
  };
}

function commitStatus(overrides: Partial<CommitStatusRead> = {}): CommitStatusRead {
  return {
    id: "status-1",
    context: "validate",
    state: "success",
    headSha: HEAD,
    targetUrl: null,
    createdAt: "2026-08-11T22:41:00Z",
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowRunRead> = {}): WorkflowRunRead {
  return {
    id: "workflow-1",
    workflowId: "ci",
    runNumber: 1,
    runAttempt: 1,
    name: "CI",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    htmlUrl: `https://github.com/${REPOSITORY}/actions/runs/1`,
    ...overrides,
  };
}

function createProvider(
  overrides: Partial<SourceControlReadProvider> = {},
): { provider: SourceControlReadProvider; state: ProviderState } {
  const state: ProviderState = { commitStatusCalls: 0 };

  const provider: SourceControlReadProvider = {
    async getRepository(): Promise<RepositoryRef> {
      return repositoryRead();
    },
    async getDefaultBranchHead(): Promise<string> {
      return MAIN;
    },
    async listOpenIssues(): Promise<IssueRead[]> {
      return [issue()];
    },
    async listOpenPullRequests(): Promise<PullRequestRead[]> {
      return [pull()];
    },
    async getPullRequest(): Promise<PullRequestRead> {
      return pull();
    },
    async getPullRequestMergeState(): Promise<PullRequestMergeStateRead> {
      return mergeState();
    },
    async listPullRequestReviews(): Promise<PullRequestReviewRead[]> {
      return [review()];
    },
    async listCheckRuns(): Promise<CheckRunRead[]> {
      return [check()];
    },
    async listCommitStatuses(): Promise<CommitStatusRead[]> {
      state.commitStatusCalls += 1;
      return [commitStatus()];
    },
    async listWorkflowRuns(): Promise<WorkflowRunRead[]> {
      return [workflow()];
    },
    ...overrides,
  };

  return { provider, state };
}

function reviewFeatures(overrides: Partial<BranchPolicyObservation["reviewFeatures"]> = {}) {
  return {
    dismissStaleReviewsOnPush: false,
    requireCodeOwnerReview: false,
    requireLastPushApproval: false,
    requireReviewThreadResolution: false,
    hasRequiredFilePatternReviewers: false,
    ...overrides,
  };
}

function activeObservation(overrides: Partial<BranchPolicyObservation> = {}): BranchPolicyObservation {
  return {
    source: "GITHUB_ACTIVE_RULES",
    repository: REPOSITORY,
    branch: "main",
    observedAt: OBSERVED_AT,
    requiredStatusChecks: [{ context: "validate", integrationId: null }],
    hasUnresolvedRequiredCheckSourceIdentity: false,
    requiredApprovals: 1,
    reviewFeatures: reviewFeatures(),
    ...overrides,
  };
}

function classicObservation(overrides: Partial<BranchPolicyObservation> = {}): BranchPolicyObservation {
  return {
    source: "GITHUB_CLASSIC_BRANCH_PROTECTION",
    repository: REPOSITORY,
    branch: "main",
    observedAt: OBSERVED_AT,
    requiredStatusChecks: [],
    hasUnresolvedRequiredCheckSourceIdentity: false,
    requiredApprovals: 0,
    reviewFeatures: reviewFeatures(),
    ...overrides,
  };
}

function completePolicy(
  activeOverrides: Partial<BranchPolicyObservation> = {},
  classicOverrides: Partial<BranchPolicyObservation> = {},
): BranchPolicyEvidence {
  return combineBranchPolicyObservations(
    [activeObservation(activeOverrides), classicObservation(classicOverrides)],
    REPOSITORY,
    "main",
    OBSERVED_AT,
  );
}

function policyReader(evidence: BranchPolicyEvidence): BranchPolicyEvidenceReader {
  return {
    async readBranchPolicyEvidence(): Promise<BranchPolicyEvidence> {
      return evidence;
    },
  };
}

function baseRequest(provider: SourceControlReadProvider, branchPolicyReader: BranchPolicyEvidenceReader) {
  return {
    provider,
    branchPolicyReader,
    repository: REPOSITORY,
    issueNumber: ISSUE_NUMBER,
    pullNumber: PULL_NUMBER,
    observedAt: OBSERVED_AT,
  } as const;
}

test("partial branch-policy evidence returns a typed blocked result without a decision model", async () => {
  const { provider } = createProvider();
  const partial = combineBranchPolicyObservations([activeObservation()], REPOSITORY, "main", OBSERVED_AT);

  const result = await reconcileAuthoritativePullRequestDecision(baseRequest(provider, policyReader(partial)));

  assert.equal(result.kind, "BLOCKED");
  assert.equal(result.policy.coverage, "PARTIAL");
  assert.deepEqual(result.policy.sources, ["GITHUB_ACTIVE_RULES"]);
  assert.ok(result.policy.blockedReasons.includes("BRANCH_POLICY_COVERAGE_INCOMPLETE"));
  assert.equal("decision" in result, false);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.mainSha, MAIN);
});

test("complete representable policy projects through the existing exact-head decision mapper", async () => {
  const { provider } = createProvider();

  const result = await reconcileAuthoritativePullRequestDecision(
    baseRequest(provider, policyReader(completePolicy())),
  );

  assert.equal(result.kind, "PROJECTED");
  if (result.kind !== "PROJECTED") return;

  assert.equal(result.policy.coverage, "COMPLETE");
  assert.deepEqual(result.policy.blockedReasons, []);
  assert.equal(result.decision.issueNumber, ISSUE_NUMBER);
  assert.equal(result.decision.prNumber, PULL_NUMBER);
  assert.equal(result.decision.expectedHeadSha, HEAD);
  assert.equal(result.decision.mainSha, MAIN);
  assert.equal(result.decision.ci, "PASS");
  assert.equal(result.decision.review, "PASS");
  assert.equal(result.decision.workflowState, "MERGE_READY");
  assert.equal(result.decision.deployImpact, "UNKNOWN");
  assert.deepEqual(result.decision.allowedActions, ["OPEN_PR"]);
  assert.equal(result.decision.lastReconciledAt, OBSERVED_AT);
});

test("explicit NOT_REQUESTED commit-status coverage skips that source and keeps required-check CI waiting", async () => {
  const { provider, state } = createProvider();

  const result = await reconcileAuthoritativePullRequestDecision({
    ...baseRequest(provider, policyReader(completePolicy())),
    commitStatusCoverage: "NOT_REQUESTED",
  });

  assert.equal(state.commitStatusCalls, 0);
  assert.equal(result.kind, "PROJECTED");
  if (result.kind !== "PROJECTED") return;

  assert.equal(result.commitStatusCoverage, "NOT_REQUESTED");
  assert.equal(result.decision.ci, "WAITING");
  assert.equal(result.decision.workflowState, "WAITING");
});

test("complete but unsupported review semantics return BLOCKED instead of fabricating review policy", async () => {
  const { provider } = createProvider();
  const evidence = completePolicy({ reviewFeatures: reviewFeatures({ requireCodeOwnerReview: true }) });

  const result = await reconcileAuthoritativePullRequestDecision(baseRequest(provider, policyReader(evidence)));

  assert.equal(result.kind, "BLOCKED");
  assert.ok(result.policy.blockedReasons.includes("CODE_OWNER_REVIEW_NOT_MODELED"));
  assert.equal("decision" in result, false);
});

test("missing requested issue fails closed", async () => {
  const { provider } = createProvider({
    async listOpenIssues(): Promise<IssueRead[]> {
      return [issue({ number: ISSUE_NUMBER + 1 })];
    },
  });

  await assert.rejects(
    reconcileAuthoritativePullRequestDecision(baseRequest(provider, policyReader(completePolicy()))),
    (error: unknown) => error instanceof AuthoritativeReconciliationError && error.code === "ISSUE_NOT_FOUND",
  );
});

test("policy repository, branch and observation-time mismatches fail closed", async () => {
  const { provider } = createProvider();
  const mismatches: BranchPolicyEvidence[] = [
    { ...completePolicy(), repository: "rozkalnsandris/hermes-deals" },
    { ...completePolicy(), branch: "release" },
    { ...completePolicy(), observedAt: "2026-08-12T00:51:00+02:00" },
  ];

  for (const evidence of mismatches) {
    await assert.rejects(
      reconcileAuthoritativePullRequestDecision(baseRequest(provider, policyReader(evidence))),
      (error: unknown) =>
        error instanceof AuthoritativeReconciliationError && error.code === "MALFORMED_EVIDENCE",
    );
  }
});

test("invalid request identity fails before authoritative reconciliation", async () => {
  const { provider } = createProvider();
  const reader = policyReader(completePolicy());

  const invalidCases = [
    { repository: "rozkalnsandris/not-managed", issueNumber: ISSUE_NUMBER, pullNumber: PULL_NUMBER, observedAt: OBSERVED_AT },
    { repository: REPOSITORY, issueNumber: 0, pullNumber: PULL_NUMBER, observedAt: OBSERVED_AT },
    { repository: REPOSITORY, issueNumber: ISSUE_NUMBER, pullNumber: 0, observedAt: OBSERVED_AT },
    { repository: REPOSITORY, issueNumber: ISSUE_NUMBER, pullNumber: PULL_NUMBER, observedAt: "not-a-time" },
  ];

  for (const invalidCase of invalidCases) {
    await assert.rejects(
      reconcileAuthoritativePullRequestDecision({ provider, branchPolicyReader: reader, ...invalidCase }),
      (error: unknown) => error instanceof AuthoritativeReconciliationError && error.code === "INVALID_REQUEST",
    );
  }
});

test("stale exact-head evidence remains rejected by the existing authoritative snapshot gate", async () => {
  const { provider } = createProvider({
    async listCheckRuns(): Promise<CheckRunRead[]> {
      return [check({ headSha: "3333333333333333333333333333333333333333" })];
    },
  });

  await assert.rejects(
    reconcileAuthoritativePullRequestDecision(baseRequest(provider, policyReader(completePolicy()))),
    /Check-run evidence does not match the observed pull-request head SHA/,
  );
});
