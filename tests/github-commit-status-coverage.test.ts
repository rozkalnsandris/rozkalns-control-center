import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCiState,
  projectAuthoritativeSnapshotToDecision,
} from "../src/shared/github-projection.js";
import {
  readAuthoritativePullRequestSnapshot,
  type ChangeRequestReadSnapshot,
  type CheckRunRead,
  type CommitStatusRead,
  type SourceControlReadProvider,
  type WorkflowRunRead,
} from "../src/shared/source-control-read.js";

const HEAD = "1111111111111111111111111111111111111111";
const MAIN = "2222222222222222222222222222222222222222";
const REPOSITORY = "rozkalnsandris/hermes-tech";

function check(overrides: Partial<CheckRunRead> = {}): CheckRunRead {
  return {
    id: "1",
    name: "validate",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    appId: null,
    detailsUrl: null,
    ...overrides,
  };
}

function status(overrides: Partial<CommitStatusRead> = {}): CommitStatusRead {
  return {
    id: "2",
    context: "validate",
    state: "success",
    headSha: HEAD,
    targetUrl: null,
    createdAt: "2026-08-11T20:00:00.000Z",
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowRunRead> = {}): WorkflowRunRead {
  return {
    id: "3",
    workflowId: "7",
    runNumber: 10,
    runAttempt: 1,
    name: "CI",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    createdAt: "2026-08-11T20:00:00.000Z",
    updatedAt: "2026-08-11T20:05:00.000Z",
    runStartedAt: "2026-08-11T20:00:30.000Z",
    htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/actions/runs/3",
    ...overrides,
  };
}

function provider(commitStatusReads: { count: number }): SourceControlReadProvider {
  return {
    async getRepository() {
      return { repository: REPOSITORY, defaultBranch: "main" };
    },
    async getDefaultBranchHead() {
      return MAIN;
    },
    async listOpenIssues() {
      return [];
    },
    async listOpenPullRequests() {
      return [];
    },
    async getPullRequest() {
      return {
        number: 42,
        title: "Coverage gate",
        state: "open",
        draft: false,
        baseRef: "main",
        baseSha: MAIN,
        headRef: "feat/coverage",
        headSha: HEAD,
        changedFiles: 2,
        htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/pull/42",
      };
    },
    async getPullRequestMergeState() {
      return {
        pullNumber: 42,
        headSha: HEAD,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        draft: false,
      };
    },
    async listPullRequestReviews() {
      return [{ id: "4", state: "APPROVED", actor: "reviewer", submittedAt: "2026-08-11T20:10:00.000Z" }];
    },
    async listCheckRuns() {
      return [check()];
    },
    async listCommitStatuses() {
      commitStatusReads.count += 1;
      return [status()];
    },
    async listWorkflowRuns() {
      return [workflow()];
    },
  };
}

const projectionContext = {
  issue: {
    number: 40,
    title: "Commit-status evidence coverage",
    state: "open" as const,
    htmlUrl: "https://github.com/rozkalnsandris/rozkalns-control-center/issues/40",
  },
  ciPolicy: {
    requiredChecks: [{ context: "validate", integrationId: null }],
    requiredWorkflowNames: ["CI"],
  },
  reviewPolicy: { requiredApprovals: 1 },
};

test("authoritative snapshot defaults to observed commit statuses", async () => {
  const reads = { count: 0 };
  const snapshot = await readAuthoritativePullRequestSnapshot(
    provider(reads),
    REPOSITORY,
    42,
    "2026-08-11T20:30:00.000Z",
  );

  assert.equal(reads.count, 1);
  assert.equal(snapshot.commitStatusCoverage, "OBSERVED");
  assert.equal(snapshot.commitStatuses.length, 1);
});

test("NOT_REQUESTED skips commit-status provider read and records empty unobserved evidence", async () => {
  const reads = { count: 0 };
  const snapshot = await readAuthoritativePullRequestSnapshot(
    provider(reads),
    REPOSITORY,
    42,
    "2026-08-11T20:30:00.000Z",
    { commitStatusCoverage: "NOT_REQUESTED" },
  );

  assert.equal(reads.count, 0);
  assert.equal(snapshot.commitStatusCoverage, "NOT_REQUESTED");
  assert.deepEqual(snapshot.commitStatuses, []);
});

test("unrequested commit statuses cannot fabricate PASS for a required status-check context", () => {
  const policy = { requiredChecks: [{ context: "validate", integrationId: null }], requiredWorkflowNames: [] };

  assert.equal(aggregateCiState([check()], [], [], policy, "NOT_REQUESTED"), "WAITING");
  assert.equal(aggregateCiState([check({ conclusion: "failure" })], [], [], policy, "NOT_REQUESTED"), "FAIL");
  assert.equal(
    aggregateCiState([check({ status: "in_progress", conclusion: null })], [], [], policy, "NOT_REQUESTED"),
    "RUNNING",
  );
});

test("workflow-only CI policy is independent of unrequested commit-status evidence", () => {
  assert.equal(
    aggregateCiState([], [], [workflow()], { requiredChecks: [], requiredWorkflowNames: ["CI"] }, "NOT_REQUESTED"),
    "PASS",
  );
});

test("projection rejects contradictory NOT_REQUESTED coverage with commit-status evidence", () => {
  const snapshot: ChangeRequestReadSnapshot = {
    repository: REPOSITORY,
    observedAt: "2026-08-11T20:30:00.000Z",
    defaultBranch: "main",
    mainSha: MAIN,
    pullRequest: {
      number: 42,
      title: "Coverage gate",
      state: "open",
      draft: false,
      baseRef: "main",
      baseSha: MAIN,
      headRef: "feat/coverage",
      headSha: HEAD,
      changedFiles: 2,
      htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/pull/42",
    },
    mergeState: {
      pullNumber: 42,
      headSha: HEAD,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      draft: false,
    },
    reviews: [{ id: "4", state: "APPROVED", actor: "reviewer", submittedAt: "2026-08-11T20:10:00.000Z" }],
    checkRuns: [check()],
    commitStatuses: [status()],
    commitStatusCoverage: "NOT_REQUESTED",
    workflowRuns: [workflow()],
    authoritativeRead: true,
  };

  assert.throws(
    () => projectAuthoritativeSnapshotToDecision(snapshot, projectionContext),
    /cannot be present when its source was not requested/,
  );
});
