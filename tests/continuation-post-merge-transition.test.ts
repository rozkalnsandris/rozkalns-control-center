import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ContinuationPostMergeTransitionError,
  planContinuationPostMergeTransition,
  type ContinuationSuccessfulMergeReceipt,
} from "../src/integrations/cloudflare/continuation-post-merge-transition.js";
import type { ContinuationCampaignRecoveryEvidence } from "../src/integrations/cloudflare/d1-continuation-campaign-reader.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const TASK_ID = "task:517";
const OTHER_TASK_ID = "task:518";
const ISSUE_NUMBER = 517;
const PULL_REQUEST_NUMBER = 700;
const EXPECTED_MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const EXPECTED_HEAD_SHA = "1111111111111111111111111111111111111111";
const MERGE_SHA = "2222222222222222222222222222222222222222";
const OTHER_SHA = "3333333333333333333333333333333333333333";
const DURABLE_AT = "2026-08-21T12:00:00.000Z";
const MERGED_AT = "2026-08-21T12:01:00.000Z";

type FoundRecovery = Extract<ContinuationCampaignRecoveryEvidence, { kind: "FOUND" }>;

function recovery(overrides: {
  humanGate?: "MERGE" | "DEPLOY" | "NEEDS_CHANGES" | "PRODUCTION_MUTATION" | null;
  currentTaskState?: "MERGE_READY" | "REVIEW" | "DONE";
  nextTaskId?: string | null;
  expectedMainSha?: string;
  currentIssueNumber?: number;
  currentPullRequestNumber?: number | null;
  currentExpectedHeadSha?: string | null;
  currentTaskUpdatedAt?: string;
  campaignUpdatedAt?: string;
} = {}): FoundRecovery {
  const currentTaskState = overrides.currentTaskState ?? "MERGE_READY";
  return {
    kind: "FOUND",
    campaign: {
      schemaVersion: 1,
      campaignId: CAMPAIGN_ID,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      scope: "lidl",
      mode: "CONTINUE_ISSUES",
      continueEnabled: true,
      paused: true,
      expectedMainSha: overrides.expectedMainSha ?? EXPECTED_MAIN_SHA,
      currentTask: { taskId: TASK_ID, state: currentTaskState },
      nextTaskId: overrides.nextTaskId ?? null,
      humanGate: overrides.humanGate === undefined ? "MERGE" : overrides.humanGate,
      observedAt: DURABLE_AT,
      updatedAt: overrides.campaignUpdatedAt ?? DURABLE_AT,
    },
    tasks: [
      {
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        issueNumber: overrides.currentIssueNumber ?? ISSUE_NUMBER,
        taskState: currentTaskState,
        activePullRequestNumber:
          overrides.currentPullRequestNumber === undefined
            ? PULL_REQUEST_NUMBER
            : overrides.currentPullRequestNumber,
        expectedHeadSha:
          overrides.currentExpectedHeadSha === undefined
            ? EXPECTED_HEAD_SHA
            : overrides.currentExpectedHeadSha,
        priority: 10,
        updatedAt: overrides.currentTaskUpdatedAt ?? DURABLE_AT,
      },
      {
        taskId: OTHER_TASK_ID,
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        issueNumber: 518,
        taskState: "DISCOVERED",
        activePullRequestNumber: null,
        expectedHeadSha: null,
        priority: 20,
        updatedAt: DURABLE_AT,
      },
    ],
  };
}

function receipt(
  overrides: Partial<ContinuationSuccessfulMergeReceipt> = {},
): ContinuationSuccessfulMergeReceipt {
  return {
    schemaVersion: 1,
    merged: true,
    campaignId: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    taskId: TASK_ID,
    issueNumber: ISSUE_NUMBER,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    expectedHeadSha: EXPECTED_HEAD_SHA,
    expectedMainSha: EXPECTED_MAIN_SHA,
    mergeSha: MERGE_SHA,
    observedMainSha: MERGE_SHA,
    observedAt: MERGED_AT,
    ...overrides,
  };
}

function rejectsWith(code: string) {
  return (error: unknown) =>
    error instanceof ContinuationPostMergeTransitionError && error.code === code;
}

test("successful exact merge yields inert DONE transition and clears next-task selection", () => {
  const durable = recovery();
  const unrelatedBefore = durable.tasks[1];

  const proposal = planContinuationPostMergeTransition(durable, receipt());

  assert.equal(proposal.kind, "POST_MERGE_TRANSITION");
  assert.deepEqual(proposal.mergeEvidence, {
    merged: true,
    taskId: TASK_ID,
    issueNumber: ISSUE_NUMBER,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    expectedHeadSha: EXPECTED_HEAD_SHA,
    previousMainSha: EXPECTED_MAIN_SHA,
    mergeSha: MERGE_SHA,
    observedAt: MERGED_AT,
  });
  assert.deepEqual(proposal.campaign, {
    schemaVersion: 1,
    campaignId: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    scope: "lidl",
    mode: "CONTINUE_ISSUES",
    continueEnabled: true,
    paused: true,
    expectedMainSha: MERGE_SHA,
    currentTask: { taskId: TASK_ID, state: "DONE" },
    nextTaskId: null,
    humanGate: null,
    observedAt: MERGED_AT,
    updatedAt: MERGED_AT,
  });
  assert.deepEqual(proposal.tasks[0], {
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    issueNumber: ISSUE_NUMBER,
    taskState: "DONE",
    activePullRequestNumber: null,
    expectedHeadSha: null,
    priority: 10,
    updatedAt: MERGED_AT,
  });
  assert.deepEqual(proposal.tasks[1], unrelatedBefore);
  assert.notStrictEqual(proposal.tasks[1], unrelatedBefore);
});

test("missing durable campaign fails closed", () => {
  assert.throws(
    () => planContinuationPostMergeTransition({ kind: "NOT_FOUND" }, receipt()),
    rejectsWith("RECOVERY_NOT_FOUND"),
  );
});

test("only the exact MERGE gate and MERGE_READY current task may transition", () => {
  assert.throws(
    () => planContinuationPostMergeTransition(recovery({ humanGate: "DEPLOY" }), receipt()),
    rejectsWith("MERGE_GATE_MISMATCH"),
  );
  assert.throws(
    () =>
      planContinuationPostMergeTransition(
        recovery({ currentTaskState: "REVIEW" }),
        receipt(),
      ),
    rejectsWith("CURRENT_TASK_MISMATCH"),
  );
});

test("receipt must match exact campaign task issue PR head and pre-merge main", () => {
  assert.throws(
    () =>
      planContinuationPostMergeTransition(
        recovery(),
        receipt({ campaignId: "campaign:hermes-deals:other" }),
      ),
    rejectsWith("RECOVERY_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationPostMergeTransition(recovery(), receipt({ issueNumber: 518 })),
    rejectsWith("MERGE_RECEIPT_MISMATCH"),
  );
  assert.throws(
    () => planContinuationPostMergeTransition(recovery(), receipt({ pullRequestNumber: 701 })),
    rejectsWith("MERGE_RECEIPT_MISMATCH"),
  );
  assert.throws(
    () => planContinuationPostMergeTransition(recovery(), receipt({ expectedHeadSha: OTHER_SHA })),
    rejectsWith("MERGE_RECEIPT_MISMATCH"),
  );
  assert.throws(
    () => planContinuationPostMergeTransition(recovery(), receipt({ expectedMainSha: OTHER_SHA })),
    rejectsWith("RECOVERY_EVIDENCE_MISMATCH"),
  );
});

test("failed merge receipt never advances durable state", () => {
  assert.throws(
    () => planContinuationPostMergeTransition(recovery(), receipt({ merged: false })),
    rejectsWith("MERGE_NOT_SUCCESSFUL"),
  );
});

test("post-merge main must equal returned merge SHA and must advance old main", () => {
  assert.throws(
    () =>
      planContinuationPostMergeTransition(
        recovery(),
        receipt({ observedMainSha: OTHER_SHA }),
      ),
    rejectsWith("POST_MERGE_MAIN_DRIFT"),
  );
  assert.throws(
    () =>
      planContinuationPostMergeTransition(
        recovery(),
        receipt({ mergeSha: EXPECTED_MAIN_SHA, observedMainSha: EXPECTED_MAIN_SHA }),
      ),
    rejectsWith("MERGE_RECEIPT_REPLAY"),
  );
});

test("post-merge observation cannot predate durable campaign or task evidence", () => {
  const future = "2026-08-21T12:02:00.000Z";
  assert.throws(
    () =>
      planContinuationPostMergeTransition(
        recovery({ campaignUpdatedAt: future }),
        receipt(),
      ),
    rejectsWith("STALE_MERGE_EVIDENCE"),
  );
  assert.throws(
    () =>
      planContinuationPostMergeTransition(
        recovery({ currentTaskUpdatedAt: future }),
        receipt(),
      ),
    rejectsWith("STALE_MERGE_EVIDENCE"),
  );
});

test("transition stays detached from Worker runtime and persistence/network APIs", () => {
  const source = readFileSync(
    resolve("src/integrations/cloudflare/continuation-post-merge-transition.ts"),
    "utf8",
  );
  const worker = readFileSync(resolve("src/worker/index.ts"), "utf8");

  assert.equal(worker.includes("continuation-post-merge-transition"), false);
  assert.equal(source.includes("D1DatabaseLike"), false);
  assert.equal(source.includes("SourceControlReadProvider"), false);
  assert.equal(source.includes(".prepare("), false);
  assert.equal(source.includes("fetch("), false);
});
