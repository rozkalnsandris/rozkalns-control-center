import assert from "node:assert/strict";
import test from "node:test";

import {
  projectAuthoritativeSnapshotToDecision,
} from "../src/shared/github-projection.js";
import {
  executeNeedsChangesDecision,
  NeedsChangesDecisionError,
  type NeedsChangesAuditClaimResult,
  type NeedsChangesAuditTerminalOutcome,
  type NeedsChangesDecisionAuditStore,
  type NeedsChangesDecisionRequest,
} from "../src/shared/needs-changes-decision.js";
import type { BranchPolicyEvidenceReader } from "../src/shared/authoritative-reconciliation.js";
import type { BranchPolicyEvidence } from "../src/shared/github-policy-evidence.js";
import type {
  ChangeRequestReadSnapshot,
  IssueRead,
  PullRequestMergeStateRead,
  PullRequestRead,
  PullRequestReviewRead,
  RepositoryRef,
  SourceControlReadProvider,
} from "../src/shared/source-control-read.js";
import type {
  GitHubPullRequestReviewWriter,
  GitHubRequestChangesWriteRequest,
} from "../src/integrations/github/pull-request-review-write.js";

const REPOSITORY = "rozkalnsandris/ops-workflows";
const ISSUE_NUMBER = 4;
const PULL_NUMBER = 3;
const HEAD = "d4c5b27e2b32d89447fe3ea1acdde9d2d2a7672e";
const MAIN = "65d521eebde6758b91b8e948820c1decdaa12b97";
const OBSERVED_AT = "2026-08-23T09:35:00.000Z";
const REQUEST_ID = "phase3_zero_policy_test_380";

const issue: IssueRead = {
  number: ISSUE_NUMBER,
  title: "Rozkalns Control Phase 3 REQUEST_CHANGES canary target",
  state: "open",
  htmlUrl: `https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
};

const pull: PullRequestRead = {
  number: PULL_NUMBER,
  title: "test: disposable Rozkalns Control review-write canary",
  state: "open",
  draft: false,
  baseRef: "main",
  baseSha: "e2fa7ecb1b1cdfab0711d8e3e147b5ae03a9a3f2",
  headRef: "phase3/control-panel-review-write-canary-237",
  headSha: HEAD,
  changedFiles: 1,
  htmlUrl: `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}`,
};

const mergeState: PullRequestMergeStateRead = {
  pullNumber: PULL_NUMBER,
  headSha: HEAD,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  draft: false,
};

function review(state: PullRequestReviewRead["state"]): PullRequestReviewRead {
  return {
    id: "review-1",
    state,
    actor: "reviewer",
    submittedAt: OBSERVED_AT,
  };
}

function snapshot(reviews: readonly PullRequestReviewRead[] = []): ChangeRequestReadSnapshot {
  return {
    repository: REPOSITORY,
    observedAt: OBSERVED_AT,
    defaultBranch: "main",
    mainSha: MAIN,
    pullRequest: pull,
    mergeState,
    reviews,
    checkRuns: [],
    commitStatuses: [],
    commitStatusCoverage: "OBSERVED",
    workflowRuns: [],
    authoritativeRead: true,
  };
}

const zeroRequirementContext = {
  issue,
  ciPolicy: { requiredChecks: [], requiredWorkflowNames: [] },
  reviewPolicy: { requiredApprovals: 0 },
} as const;

function reviewFeatures() {
  return {
    dismissStaleReviewsOnPush: false,
    requireCodeOwnerReview: false,
    requireLastPushApproval: false,
    requireReviewThreadResolution: false,
    hasRequiredFilePatternReviewers: false,
  } as const;
}

function policyReader(coverage: "COMPLETE" | "PARTIAL" = "COMPLETE"): BranchPolicyEvidenceReader {
  return {
    async readBranchPolicyEvidence(repository, branch, observedAt): Promise<BranchPolicyEvidence> {
      return {
        repository,
        branch,
        observedAt,
        coverage,
        sources:
          coverage === "COMPLETE"
            ? ["GITHUB_ACTIVE_RULES", "GITHUB_CLASSIC_BRANCH_PROTECTION"]
            : ["GITHUB_ACTIVE_RULES"],
        requiredStatusChecks: [],
        hasUnresolvedRequiredCheckSourceIdentity: false,
        requiredApprovals: 0,
        reviewFeatures: reviewFeatures(),
      };
    },
  };
}

function provider(reviews: readonly PullRequestReviewRead[] = []): SourceControlReadProvider {
  const repositoryRef: RepositoryRef = { repository: REPOSITORY, defaultBranch: "main" };
  return {
    async getRepository(): Promise<RepositoryRef> {
      return repositoryRef;
    },
    async getDefaultBranchHead(): Promise<string> {
      return MAIN;
    },
    async listOpenIssues(): Promise<IssueRead[]> {
      return [issue];
    },
    async listOpenPullRequests(): Promise<PullRequestRead[]> {
      return [pull];
    },
    async getPullRequest(): Promise<PullRequestRead> {
      return pull;
    },
    async getPullRequestMergeState(): Promise<PullRequestMergeStateRead> {
      return mergeState;
    },
    async listPullRequestReviews(): Promise<PullRequestReviewRead[]> {
      return [...reviews];
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

class AuditStore implements NeedsChangesDecisionAuditStore {
  completion: NeedsChangesAuditTerminalOutcome | null = null;

  async claim(): Promise<NeedsChangesAuditClaimResult> {
    return { kind: "CLAIMED" };
  }

  async complete(
    _requestId: string,
    _fingerprint: string,
    outcome: NeedsChangesAuditTerminalOutcome,
  ): Promise<void> {
    this.completion = outcome;
  }
}

function request(): NeedsChangesDecisionRequest {
  return {
    requestId: REQUEST_ID,
    actor: { subject: "access-user-380", email: null },
    repository: REPOSITORY,
    issueNumber: ISSUE_NUMBER,
    pullNumber: PULL_NUMBER,
    expectedHeadSha: HEAD,
    expectedMainSha: MAIN,
    body: "Bounded zero-requirement policy review-write regression.",
  };
}

function writer(calls: GitHubRequestChangesWriteRequest[]): GitHubPullRequestReviewWriter {
  return {
    async requestChanges(input) {
      calls.push(input);
      return {
        reviewId: "380",
        state: "CHANGES_REQUESTED",
        commitId: HEAD,
        htmlUrl: `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}#pullrequestreview-380`,
        submittedAt: OBSERVED_AT,
      };
    },
  };
}

test("complete zero-requirement policy projects MERGE_READY without inventing requirements", () => {
  const decision = projectAuthoritativeSnapshotToDecision(snapshot(), zeroRequirementContext);

  assert.equal(decision.ci, "PASS");
  assert.equal(decision.review, "NOT_REQUIRED");
  assert.equal(decision.workflowState, "MERGE_READY");
  assert.match(decision.reason, /policy is satisfied/);
});

test("missing CI policy remains fail-closed even when review requirements are zero", () => {
  const decision = projectAuthoritativeSnapshotToDecision(snapshot(), {
    issue,
    reviewPolicy: { requiredApprovals: 0 },
  });

  assert.equal(decision.ci, "WAITING");
  assert.equal(decision.review, "NOT_REQUIRED");
  assert.equal(decision.workflowState, "WAITING");
});

test("existing CHANGES_REQUESTED remains non-ready when zero approvals are required", () => {
  const decision = projectAuthoritativeSnapshotToDecision(
    snapshot([review("CHANGES_REQUESTED")]),
    zeroRequirementContext,
  );

  assert.equal(decision.ci, "PASS");
  assert.equal(decision.review, "CHANGES_REQUESTED");
  assert.equal(decision.workflowState, "NEEDS_ANDRIS");
});

test("Needs changes decision accepts COMPLETE zero requirements and invokes writer exactly once", async () => {
  const writes: GitHubRequestChangesWriteRequest[] = [];
  const audit = new AuditStore();

  const result = await executeNeedsChangesDecision(request(), {
    provider: provider(),
    branchPolicyReader: policyReader(),
    writer: writer(writes),
    auditStore: audit,
    clock: () => new Date(OBSERVED_AT),
  });

  assert.equal(result.status, "CHANGES_REQUESTED");
  assert.equal(result.observedHeadSha, HEAD);
  assert.equal(result.observedMainSha, MAIN);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.expectedHeadSha, HEAD);
  assert.equal(audit.completion?.kind, "SUCCEEDED");
});

test("Needs changes decision still rejects existing changes-requested review before writer", async () => {
  const writes: GitHubRequestChangesWriteRequest[] = [];
  const audit = new AuditStore();

  await assert.rejects(
    executeNeedsChangesDecision(request(), {
      provider: provider([review("CHANGES_REQUESTED")]),
      branchPolicyReader: policyReader(),
      writer: writer(writes),
      auditStore: audit,
      clock: () => new Date(OBSERVED_AT),
    }),
    (error: unknown) => error instanceof NeedsChangesDecisionError && error.code === "DECISION_NOT_READY",
  );

  assert.equal(writes.length, 0);
  assert.deepEqual(audit.completion, { kind: "FAILED", code: "DECISION_NOT_READY" });
});

test("Needs changes decision keeps PARTIAL policy fail-closed before writer", async () => {
  const writes: GitHubRequestChangesWriteRequest[] = [];
  const audit = new AuditStore();

  await assert.rejects(
    executeNeedsChangesDecision(request(), {
      provider: provider(),
      branchPolicyReader: policyReader("PARTIAL"),
      writer: writer(writes),
      auditStore: audit,
      clock: () => new Date(OBSERVED_AT),
    }),
    (error: unknown) =>
      error instanceof NeedsChangesDecisionError && error.code === "POLICY_EVIDENCE_INCOMPLETE",
  );

  assert.equal(writes.length, 0);
  assert.deepEqual(audit.completion, { kind: "FAILED", code: "POLICY_EVIDENCE_INCOMPLETE" });
});
