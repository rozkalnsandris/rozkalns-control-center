import assert from "node:assert/strict";
import test from "node:test";

import {
  keepExactHeadCheckRuns,
  keepExactHeadWorkflowRuns,
  mapGitHubCheckRun,
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
    detailsUrl: null,
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
    reviews: [review()],
    checkRuns: [check()],
    workflowRuns: [workflow()],
    authoritativeRead: true,
    ...overrides,
  };
}

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

test("check mapper supports current pending-like statuses and fails closed on unknown values", () => {
  const mapped = mapGitHubCheckRun({
    id: 1,
    name: "validate",
    status: "waiting",
    conclusion: null,
    head_sha: HEAD,
    details_url: null,
  });
  assert.equal(mapped.status, "waiting");

  assert.throws(
    () =>
      mapGitHubCheckRun({
        id: 1,
        name: "validate",
        status: "brand_new_status",
        conclusion: null,
        head_sha: HEAD,
        details_url: null,
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

test("exact-head helpers exclude evidence from a different PR head", () => {
  const checks = keepExactHeadCheckRuns(
    [
      { id: 1, name: "validate", status: "completed", conclusion: "success", head_sha: HEAD, details_url: null },
      { id: 2, name: "validate", status: "completed", conclusion: "success", head_sha: OTHER_HEAD, details_url: null },
    ],
    HEAD,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.headSha, HEAD);

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
  assert.equal(aggregateCiState([], []), "WAITING");
  assert.equal(
    aggregateCiState([check()], [workflow()], { requiredCheckNames: [], requiredWorkflowNames: [] }),
    "WAITING",
  );
  assert.equal(
    aggregateCiState([check({ status: "in_progress", conclusion: null })], [], {
      requiredCheckNames: ["validate"],
      requiredWorkflowNames: [],
    }),
    "RUNNING",
  );
  assert.equal(
    aggregateCiState([check({ conclusion: "failure" })], [], {
      requiredCheckNames: ["validate"],
      requiredWorkflowNames: [],
    }),
    "FAIL",
  );
  assert.equal(
    aggregateCiState([check({ conclusion: "cancelled" })], [], {
      requiredCheckNames: ["validate"],
      requiredWorkflowNames: [],
    }),
    "WAITING",
  );
  assert.equal(
    aggregateCiState([check()], [workflow()], {
      requiredCheckNames: ["validate"],
      requiredWorkflowNames: ["CI"],
    }),
    "PASS",
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

test("authoritative projection preserves the Phase 1 UI contract without enabling Merge", () => {
  const projected = projectAuthoritativeSnapshotToDecision(snapshot(), {
    issue: {
      number: 10,
      title: "Projection parity",
      state: "open",
      htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/issues/10",
    },
    ciPolicy: { requiredCheckNames: ["validate"], requiredWorkflowNames: ["CI"] },
    reviewPolicy: { requiredApprovals: 1 },
  });

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

test("projection rejects stale-head evidence even if statuses look green", () => {
  assert.throws(
    () =>
      projectAuthoritativeSnapshotToDecision(
        snapshot({ checkRuns: [check({ headSha: OTHER_HEAD })] }),
        {
          issue: {
            number: 10,
            title: "Projection parity",
            state: "open",
            htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/issues/10",
          },
          ciPolicy: { requiredCheckNames: ["validate"], requiredWorkflowNames: ["CI"] },
          reviewPolicy: { requiredApprovals: 1 },
        },
      ),
    /different pull-request head SHA/,
  );
});
