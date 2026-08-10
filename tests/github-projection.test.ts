import assert from "node:assert/strict";
import test from "node:test";

import { mapGitHubGraphqlPullRequestMergeState } from "../src/shared/github-graphql-mappers.js";
import {
  keepExactHeadCheckRuns,
  keepExactHeadWorkflowRuns,
  keepLatestExactHeadCommitStatuses,
  mapGitHubCheckRun,
  mapGitHubCommitStatus,
  mapGitHubIssue,
  mapGitHubPullRequest,
  mapGitHubPullRequestReview,
  mapGitHubRepository,
  mapGitHubWorkflowRun,
} from "../src/shared/github-rest-mappers.js";
import {
  aggregateCiState,
  aggregateReviewState,
  projectAuthoritativeSnapshotToDecision,
} from "../src/shared/github-projection.js";
import type {
  ChangeRequestReadSnapshot,
  CheckRunRead,
  CommitStatusRead,
  PullRequestMergeStateRead,
  PullRequestReviewRead,
  WorkflowRunRead,
} from "../src/shared/source-control-read.js";
import { controlFixtures } from "../src/shared/control-fixtures.js";

const HEAD = "1111111111111111111111111111111111111111";
const OTHER_HEAD = "2222222222222222222222222222222222222222";
const MAIN = "3333333333333333333333333333333333333333";

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

function commitStatus(overrides: Partial<CommitStatusRead> = {}): CommitStatusRead {
  return {
    id: "4",
    context: "validate",
    state: "success",
    headSha: HEAD,
    targetUrl: null,
    createdAt: "2026-08-10T12:10:00Z",
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowRunRead> = {}): WorkflowRunRead {
  return {
    id: "2",
    name: "CI",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    htmlUrl: "https://github.com/example/actions/runs/2",
    ...overrides,
  };
}

function review(overrides: Partial<PullRequestReviewRead> = {}): PullRequestReviewRead {
  return {
    id: "3",
    state: "APPROVED",
    actor: "reviewer",
    submittedAt: "2026-08-10T12:00:00Z",
    ...overrides,
  };
}

function mergeState(overrides: Partial<PullRequestMergeStateRead> = {}): PullRequestMergeStateRead {
  return {
    pullNumber: 42,
    headSha: HEAD,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    draft: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ChangeRequestReadSnapshot> = {}): ChangeRequestReadSnapshot {
  return {
    repository: "rozkalnsandris/hermes-tech",
    observedAt: "2026-08-10T12:30:00Z",
    defaultBranch: "main",
    mainSha: MAIN,
    pullRequest: {
      number: 42,
      title: "Tighten read projection",
      state: "open",
      draft: false,
      baseRef: "main",
      baseSha: MAIN,
      headRef: "feat/read-projection",
      headSha: HEAD,
      changedFiles: 4,
      htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/pull/42",
    },
    mergeState: mergeState(),
    reviews: [review()],
    checkRuns: [check()],
    commitStatuses: [],
    workflowRuns: [workflow()],
    authoritativeRead: true,
    ...overrides,
  };
}

const projectionContext = {
  issue: {
    number: 10,
    title: "Projection parity",
    state: "open" as const,
    htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/issues/10",
  },
  ciPolicy: {
    requiredChecks: [{ context: "validate", integrationId: null }],
    requiredWorkflowNames: ["CI"],
  },
  reviewPolicy: { requiredApprovals: 1 },
};

test("GitHub REST mappers accept only consumed documented fields", () => {
  assert.deepEqual(
    mapGitHubRepository({ full_name: "rozkalnsandris/hermes-tech", default_branch: "main", ignored: true }),
    { repository: "rozkalnsandris/hermes-tech", defaultBranch: "main" },
  );

  assert.equal(
    mapGitHubPullRequest({
      number: 42,
      title: "Projection",
      state: "open",
      draft: false,
      base: { ref: "main", sha: MAIN },
      head: { ref: "feat/projection", sha: HEAD },
      changed_files: 3,
      html_url: "https://github.com/rozkalnsandris/hermes-tech/pull/42",
    }).headSha,
    HEAD,
  );

  assert.equal(
    mapGitHubPullRequestReview({
      id: 9,
      state: "APPROVED",
      user: { login: "andris-review" },
      submitted_at: "2026-08-10T12:00:00Z",
    }).state,
    "APPROVED",
  );

  assert.equal(
    mapGitHubIssue({
      number: 10,
      title: "Issue",
      state: "open",
      html_url: "https://github.com/rozkalnsandris/hermes-tech/issues/10",
    }).number,
    10,
  );
});

test("GraphQL merge-state mapper accepts documented values and fails closed on unknown ones", () => {
  assert.deepEqual(
    mapGitHubGraphqlPullRequestMergeState({
      number: 42,
      headRefOid: HEAD,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      isDraft: false,
      ignored: true,
    }),
    mergeState(),
  );

  assert.throws(
    () =>
      mapGitHubGraphqlPullRequestMergeState({
        number: 42,
        headRefOid: HEAD,
        mergeable: "MERGEABLE",
        mergeStateStatus: "FUTURE_STATE",
        isDraft: false,
      }),
    /unsupported value/,
  );
});

test("check mapper preserves producer App identity and pending-like status", () => {
  const mapped = mapGitHubCheckRun({
    id: 1,
    name: "validate",
    status: "waiting",
    conclusion: null,
    head_sha: HEAD,
    app: { id: 15368 },
    details_url: null,
  });
  assert.equal(mapped.status, "waiting");
  assert.equal(mapped.appId, 15368);

  assert.equal(
    mapGitHubCheckRun({
      id: 2,
      name: "validate",
      status: "completed",
      conclusion: "success",
      head_sha: HEAD,
      app: null,
      details_url: null,
    }).appId,
    null,
  );

  assert.throws(
    () =>
      mapGitHubCheckRun({
        id: 1,
        name: "validate",
        status: "brand_new_status",
        conclusion: null,
        head_sha: HEAD,
        app: { id: 15368 },
        details_url: null,
      }),
    /unsupported value/,
  );

  assert.throws(
    () =>
      mapGitHubCheckRun({
        id: 1,
        name: "validate",
        status: "completed",
        conclusion: "success",
        head_sha: HEAD,
        app: { id: 0 },
        details_url: null,
      }),
    /positive integer/,
  );
});

test("commit-status mapper accepts documented states and rejects malformed state", () => {
  assert.deepEqual(
    mapGitHubCommitStatus({
      id: 4,
      context: "ci/legacy",
      state: "pending",
      sha: HEAD,
      target_url: null,
      created_at: "2026-08-10T12:00:00Z",
    }),
    commitStatus({ id: "4", context: "ci/legacy", state: "pending", createdAt: "2026-08-10T12:00:00Z" }),
  );

  assert.throws(
    () =>
      mapGitHubCommitStatus({
        id: 4,
        context: "ci/legacy",
        state: "neutral",
        sha: HEAD,
        target_url: null,
        created_at: "2026-08-10T12:00:00Z",
      }),
    /unsupported value/,
  );
});

test("workflow mapper fails closed on malformed critical fields", () => {
  assert.throws(
    () =>
      mapGitHubWorkflowRun({
        id: 1,
        name: "CI",
        status: "completed",
        conclusion: "success",
        head_sha: "",
        html_url: "https://github.com/example/actions/runs/1",
      }),
    /non-empty string/,
  );
});

test("exact-head helpers exclude stale evidence and commit statuses use latest case-insensitive context", () => {
  const checks = keepExactHeadCheckRuns(
    [
      { id: 1, name: "validate", status: "completed", conclusion: "success", head_sha: HEAD, app: null, details_url: null },
      { id: 2, name: "validate", status: "completed", conclusion: "success", head_sha: OTHER_HEAD, app: null, details_url: null },
    ],
    HEAD,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.headSha, HEAD);

  const statuses = keepLatestExactHeadCommitStatuses(
    [
      { id: 10, context: "Validate", state: "success", sha: HEAD, target_url: null, created_at: "2026-08-10T12:10:00Z" },
      { id: 9, context: "validate", state: "failure", sha: HEAD, target_url: null, created_at: "2026-08-10T12:09:00Z" },
      { id: 8, context: "security", state: "success", sha: OTHER_HEAD, target_url: null, created_at: "2026-08-10T12:08:00Z" },
    ],
    HEAD,
  );
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.context, "Validate");
  assert.equal(statuses[0]?.state, "success");

  const runs = keepExactHeadWorkflowRuns(
    [
      { id: 1, name: "CI", status: "completed", conclusion: "success", head_sha: HEAD, html_url: "https://example/1" },
      { id: 2, name: "CI", status: "completed", conclusion: "success", head_sha: OTHER_HEAD, html_url: "https://example/2" },
    ],
    HEAD,
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.headSha, HEAD);
});

test("CI aggregation never invents PASS without explicit complete policy evidence", () => {
  assert.equal(aggregateCiState([], [], []), "WAITING");
  assert.equal(
    aggregateCiState([check()], [], [workflow()], { requiredChecks: [], requiredWorkflowNames: [] }),
    "WAITING",
  );
  assert.equal(
    aggregateCiState([check({ status: "in_progress", conclusion: null })], [], [], {
      requiredChecks: [{ context: "validate", integrationId: null }],
      requiredWorkflowNames: [],
    }),
    "RUNNING",
  );
  assert.equal(
    aggregateCiState([check({ conclusion: "failure" })], [], [], {
      requiredChecks: [{ context: "validate", integrationId: null }],
      requiredWorkflowNames: [],
    }),
    "FAIL",
  );
  assert.equal(
    aggregateCiState([check({ conclusion: "cancelled" })], [], [], {
      requiredChecks: [{ context: "validate", integrationId: null }],
      requiredWorkflowNames: [],
    }),
    "WAITING",
  );
  assert.equal(
    aggregateCiState([check()], [], [workflow()], {
      requiredChecks: [{ context: "validate", integrationId: null }],
      requiredWorkflowNames: ["CI"],
    }),
    "PASS",
  );
});

test("neutral and skipped completed Checks satisfy GitHub required-status semantics", () => {
  const policy = { requiredChecks: [{ context: "validate", integrationId: null }], requiredWorkflowNames: [] };
  assert.equal(aggregateCiState([check({ conclusion: "neutral" })], [], [], policy), "PASS");
  assert.equal(aggregateCiState([check({ conclusion: "skipped" })], [], [], policy), "PASS");
});

test("commit status can satisfy a required context and mixed Check/status evidence must both pass", () => {
  const policy = { requiredChecks: [{ context: "VALIDATE", integrationId: null }], requiredWorkflowNames: [] };

  assert.equal(aggregateCiState([], [commitStatus()], [], policy), "PASS");
  assert.equal(aggregateCiState([], [commitStatus({ state: "pending" })], [], policy), "RUNNING");
  assert.equal(aggregateCiState([], [commitStatus({ state: "error" })], [], policy), "FAIL");
  assert.equal(aggregateCiState([check()], [commitStatus()], [], policy), "PASS");
  assert.equal(aggregateCiState([check()], [commitStatus({ state: "failure" })], [], policy), "FAIL");
});

test("App-bound required checks accept only matching Check producer identity", () => {
  const policy = { requiredChecks: [{ context: "validate", integrationId: 15368 }], requiredWorkflowNames: [] };

  assert.equal(aggregateCiState([check({ appId: 15368 })], [], [], policy), "PASS");
  assert.equal(aggregateCiState([check({ appId: 999 })], [], [], policy), "WAITING");
  assert.equal(aggregateCiState([check({ appId: null })], [], [], policy), "WAITING");
  assert.equal(aggregateCiState([], [commitStatus()], [], policy), "WAITING");
  assert.equal(aggregateCiState([check({ appId: 15368 })], [commitStatus()], [], policy), "WAITING");
  assert.equal(
    aggregateCiState([check({ appId: 15368 })], [commitStatus({ state: "failure" })], [], policy),
    "FAIL",
  );
});

test("review aggregation uses the latest effective review per actor and requires explicit policy", () => {
  assert.equal(aggregateReviewState([review()]), "PENDING");
  assert.equal(aggregateReviewState([review()], { requiredApprovals: 1 }), "PASS");

  assert.equal(
    aggregateReviewState(
      [
        review({ id: "1", actor: "same-user", state: "APPROVED" }),
        review({ id: "2", actor: "same-user", state: "CHANGES_REQUESTED" }),
      ],
      { requiredApprovals: 1 },
    ),
    "CHANGES_REQUESTED",
  );

  assert.equal(
    aggregateReviewState(
      [
        review({ id: "1", actor: "same-user", state: "APPROVED" }),
        review({ id: "2", actor: "same-user", state: "COMMENTED" }),
      ],
      { requiredApprovals: 1 },
    ),
    "PENDING",
  );
});

test("authoritative projection preserves the Phase 1 UI contract without enabling a write action", () => {
  const projected = projectAuthoritativeSnapshotToDecision(snapshot(), projectionContext);

  assert.equal(projected.workflowState, "MERGE_READY");
  assert.equal(projected.ci, "PASS");
  assert.equal(projected.review, "PASS");
  assert.equal(projected.deployImpact, "UNKNOWN");
  assert.deepEqual(projected.allowedActions, ["OPEN_PR"]);
  assert.equal(projected.expectedHeadSha, HEAD);
  assert.equal(projected.currentHeadSha, HEAD);

  const fixtureKeys = Object.keys(controlFixtures.decisions[0] ?? {}).sort();
  const projectedKeys = Object.keys(projected).sort();
  assert.deepEqual(projectedKeys, fixtureKeys);
});

test("only authoritative MERGEABLE/CLEAN merge state can produce MERGE_READY", () => {
  const nonReadyStates = ["BEHIND", "BLOCKED", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"] as const;

  for (const mergeStateStatus of nonReadyStates) {
    const projected = projectAuthoritativeSnapshotToDecision(
      snapshot({ mergeState: mergeState({ mergeStateStatus }) }),
      projectionContext,
    );
    assert.equal(projected.workflowState, "WAITING", mergeStateStatus);
    assert.match(projected.reason, /GitHub merge state/);
  }

  const conflicting = projectAuthoritativeSnapshotToDecision(
    snapshot({ mergeState: mergeState({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) }),
    projectionContext,
  );
  assert.equal(conflicting.workflowState, "WAITING");
});

test("projection rejects stale-head evidence even if statuses look green", () => {
  assert.throws(
    () =>
      projectAuthoritativeSnapshotToDecision(
        snapshot({ checkRuns: [check({ headSha: OTHER_HEAD })] }),
        projectionContext,
      ),
    /different pull-request head SHA/,
  );

  assert.throws(
    () =>
      projectAuthoritativeSnapshotToDecision(
        snapshot({ commitStatuses: [commitStatus({ headSha: OTHER_HEAD })] }),
        projectionContext,
      ),
    /commit-status evidence from a different pull-request head SHA/,
  );

  assert.throws(
    () =>
      projectAuthoritativeSnapshotToDecision(
        snapshot({ mergeState: mergeState({ headSha: OTHER_HEAD }) }),
        projectionContext,
      ),
    /merge-state evidence from a different pull-request head SHA/,
  );
});
