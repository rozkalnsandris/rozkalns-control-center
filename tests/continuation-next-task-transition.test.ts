import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type {
  ContinuationHumanGate,
  ContinuationPlanResult,
  ContinuationTaskState,
} from "../src/shared/continuation-plan.js";
import {
  ContinuationNextTaskTransitionError,
  planContinuationNextTaskTransition,
} from "../src/integrations/cloudflare/continuation-next-task-transition.js";
import type { ContinuationPostMergeTransitionProposal } from "../src/integrations/cloudflare/continuation-post-merge-transition.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const MERGED_TASK_ID = "task:517";
const NEXT_TASK_ID = "task:518";
const OTHER_TASK_ID = "task:519";
const PREVIOUS_MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const MERGE_SHA = "1111111111111111111111111111111111111111";
const DRIFT_SHA = "2222222222222222222222222222222222222222";
const EXPECTED_HEAD_SHA = "3333333333333333333333333333333333333333";
const TRANSITION_AT = "2026-08-21T16:20:40.000Z";
const READY_AT = "2026-08-21T16:21:00.000Z";
const STALE_AT = "2026-08-21T16:20:39.000Z";

interface TaskFixture {
  readonly taskId: string;
  readonly issueNumber: number;
  readonly taskState: ContinuationTaskState;
  readonly activePullRequestNumber?: number | null;
  readonly expectedHeadSha?: string | null;
  readonly priority?: number;
  readonly updatedAt?: string;
}

function transition(
  options: {
    readonly nextTaskId?: string | null;
    readonly humanGate?: ContinuationHumanGate | null;
    readonly continueEnabled?: boolean;
    readonly paused?: boolean;
    readonly currentTaskState?: ContinuationTaskState;
    readonly expectedMainSha?: string;
    readonly campaignObservedAt?: string;
    readonly campaignUpdatedAt?: string;
    readonly tasks?: readonly TaskFixture[];
  } = {},
): ContinuationPostMergeTransitionProposal {
  const tasks = options.tasks ?? [
    {
      taskId: MERGED_TASK_ID,
      issueNumber: 517,
      taskState: "DONE" as const,
      priority: 10,
      updatedAt: TRANSITION_AT,
    },
    {
      taskId: NEXT_TASK_ID,
      issueNumber: 518,
      taskState: "DISCOVERED" as const,
      priority: 20,
      updatedAt: "2026-08-21T16:19:00.000Z",
    },
    {
      taskId: OTHER_TASK_ID,
      issueNumber: 519,
      taskState: "READY" as const,
      priority: 30,
      updatedAt: "2026-08-21T16:18:00.000Z",
    },
  ];

  return {
    schemaVersion: 1,
    kind: "POST_MERGE_TRANSITION",
    mergeEvidence: {
      merged: true,
      taskId: MERGED_TASK_ID,
      issueNumber: 517,
      pullRequestNumber: 600,
      expectedHeadSha: EXPECTED_HEAD_SHA,
      previousMainSha: PREVIOUS_MAIN_SHA,
      mergeSha: MERGE_SHA,
      observedAt: TRANSITION_AT,
    },
    campaign: {
      schemaVersion: 1,
      campaignId: CAMPAIGN_ID,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      scope: "lidl",
      mode: "CONTINUE_ISSUES",
      continueEnabled: options.continueEnabled ?? true,
      paused: options.paused ?? false,
      expectedMainSha: options.expectedMainSha ?? MERGE_SHA,
      currentTask: {
        taskId: MERGED_TASK_ID,
        state: options.currentTaskState ?? "DONE",
      },
      nextTaskId: options.nextTaskId ?? null,
      humanGate: options.humanGate ?? null,
      observedAt: options.campaignObservedAt ?? TRANSITION_AT,
      updatedAt: options.campaignUpdatedAt ?? TRANSITION_AT,
    },
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      issueNumber: task.issueNumber,
      taskState: task.taskState,
      activePullRequestNumber: task.activePullRequestNumber ?? null,
      expectedHeadSha: task.expectedHeadSha ?? null,
      priority: task.priority ?? 10,
      updatedAt: task.updatedAt ?? TRANSITION_AT,
    })),
  };
}

function ready(
  options: {
    readonly campaignId?: string;
    readonly projectId?: string;
    readonly repository?: string;
    readonly taskId?: string;
    readonly issueNumber?: number;
    readonly expectedMainSha?: string;
    readonly observedAt?: string;
  } = {},
): Extract<ContinuationPlanResult, { readonly kind: "READY" }> {
  return {
    kind: "READY",
    campaignId: options.campaignId ?? CAMPAIGN_ID,
    projectId: options.projectId ?? PROJECT_ID,
    repository: options.repository ?? REPOSITORY,
    taskId: options.taskId ?? NEXT_TASK_ID,
    issueNumber: options.issueNumber ?? 518,
    expectedMainSha: options.expectedMainSha ?? MERGE_SHA,
    observedAt: options.observedAt ?? READY_AT,
  };
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof ContinuationNextTaskTransitionError && error.code === code;
}

test("exact READY evidence reserves only nextTaskId and preserves all task rows", () => {
  const input = transition();
  const proposal = planContinuationNextTaskTransition(input, ready());

  assert.equal(proposal.kind, "NEXT_TASK_TRANSITION");
  assert.deepEqual(proposal.selectionEvidence, {
    taskId: NEXT_TASK_ID,
    issueNumber: 518,
    expectedMainSha: MERGE_SHA,
    observedAt: READY_AT,
  });
  assert.deepEqual(proposal.campaign, {
    schemaVersion: 1,
    campaignId: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    scope: "lidl",
    mode: "CONTINUE_ISSUES",
    continueEnabled: true,
    paused: false,
    expectedMainSha: MERGE_SHA,
    currentTask: { taskId: MERGED_TASK_ID, state: "DONE" },
    nextTaskId: NEXT_TASK_ID,
    humanGate: null,
    observedAt: READY_AT,
    updatedAt: READY_AT,
  });
  assert.deepEqual(proposal.tasks, input.tasks);
  assert.notEqual(proposal.tasks, input.tasks);
  assert.deepEqual(
    proposal.tasks.find((task) => task.taskId === NEXT_TASK_ID),
    input.tasks.find((task) => task.taskId === NEXT_TASK_ID),
  );
});

test("non-READY plans cannot be coerced into a next-task transition", () => {
  for (const plan of [
    { kind: "NO_ELIGIBLE_TASK" } as const,
    { kind: "PAUSED" } as const,
    { kind: "CONTINUATION_DISABLED" } as const,
    { kind: "HUMAN_GATE", gate: "MERGE" } as const,
  ]) {
    assert.throws(
      () => planContinuationNextTaskTransition(transition(), plan),
      expectCode("READY_PLAN_REQUIRED"),
    );
  }
});

test("READY campaign/repository/main identity drift fails closed", () => {
  assert.throws(
    () => planContinuationNextTaskTransition(transition(), ready({ campaignId: "campaign:other" })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationNextTaskTransition(transition(), ready({ repository: "rozkalnsandris/hermes-tech" })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationNextTaskTransition(transition(), ready({ expectedMainSha: DRIFT_SHA })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationNextTaskTransition(transition({ expectedMainSha: DRIFT_SHA }), ready()),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
});

test("READY task and issue must match one exact selectable durable row", () => {
  assert.throws(
    () => planContinuationNextTaskTransition(transition(), ready({ taskId: "task:999" })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationNextTaskTransition(transition(), ready({ issueNumber: 999 })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationNextTaskTransition(transition(), ready({ taskId: MERGED_TASK_ID, issueNumber: 517 })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
});

test("selected task cannot be in progress or acquire PR/head evidence", () => {
  const working = transition({
    tasks: [
      { taskId: MERGED_TASK_ID, issueNumber: 517, taskState: "DONE", updatedAt: TRANSITION_AT },
      { taskId: NEXT_TASK_ID, issueNumber: 518, taskState: "WORKING", updatedAt: TRANSITION_AT },
    ],
  });
  assert.throws(
    () => planContinuationNextTaskTransition(working, ready()),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );

  const withPull = transition({
    tasks: [
      { taskId: MERGED_TASK_ID, issueNumber: 517, taskState: "DONE", updatedAt: TRANSITION_AT },
      {
        taskId: NEXT_TASK_ID,
        issueNumber: 518,
        taskState: "READY",
        activePullRequestNumber: 601,
        expectedHeadSha: EXPECTED_HEAD_SHA,
        updatedAt: TRANSITION_AT,
      },
    ],
  });
  assert.throws(
    () => planContinuationNextTaskTransition(withPull, ready()),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
});

test("post-merge transition must still be unbound, ungated, enabled and unpaused", () => {
  assert.throws(
    () => planContinuationNextTaskTransition(transition({ nextTaskId: NEXT_TASK_ID }), ready()),
    expectCode("TRANSITION_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationNextTaskTransition(transition({ humanGate: "MERGE" }), ready()),
    expectCode("TRANSITION_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationNextTaskTransition(transition({ paused: true }), ready()),
    expectCode("TRANSITION_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationNextTaskTransition(transition({ continueEnabled: false }), ready()),
    expectCode("TRANSITION_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationNextTaskTransition(transition({ currentTaskState: "MERGE_READY" }), ready()),
    expectCode("TRANSITION_EVIDENCE_MISMATCH"),
  );
});

test("READY observation cannot predate the merge transition or selected-task evidence", () => {
  assert.throws(
    () => planContinuationNextTaskTransition(transition(), ready({ observedAt: STALE_AT })),
    expectCode("STALE_READY_EVIDENCE"),
  );

  const newerTask = transition({
    tasks: [
      { taskId: MERGED_TASK_ID, issueNumber: 517, taskState: "DONE", updatedAt: TRANSITION_AT },
      {
        taskId: NEXT_TASK_ID,
        issueNumber: 518,
        taskState: "DISCOVERED",
        updatedAt: "2026-08-21T16:21:01.000Z",
      },
    ],
  });
  assert.throws(
    () => planContinuationNextTaskTransition(newerTask, ready()),
    expectCode("STALE_READY_EVIDENCE"),
  );
});

test("duplicate durable task or issue evidence fails closed", () => {
  const duplicate = transition({
    tasks: [
      { taskId: MERGED_TASK_ID, issueNumber: 517, taskState: "DONE", updatedAt: TRANSITION_AT },
      { taskId: NEXT_TASK_ID, issueNumber: 518, taskState: "DISCOVERED", updatedAt: TRANSITION_AT },
      { taskId: NEXT_TASK_ID, issueNumber: 519, taskState: "READY", updatedAt: TRANSITION_AT },
    ],
  });
  assert.throws(
    () => planContinuationNextTaskTransition(duplicate, ready()),
    expectCode("TRANSITION_EVIDENCE_MISMATCH"),
  );
});

test("next-task transition remains detached and contains no persistence or runtime capability", () => {
  const source = readFileSync(
    resolve("src/integrations/cloudflare/continuation-next-task-transition.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /\b(?:fetch|send|enqueue|schedule|deploy|persist|write)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
  assert.doesNotMatch(source, /\.prepare\s*\(/u);
  assert.doesNotMatch(source, /\bD1DatabaseLike\b/u);
  assert.doesNotMatch(source, /(?:CONTROL_NOTIFICATION_|CLOUDFLARE_|GITHUB_TOKEN)/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:worker|queue|notification|store)/u);
});
