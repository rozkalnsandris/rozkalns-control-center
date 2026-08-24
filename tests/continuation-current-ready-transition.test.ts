import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { ContinuationPlanResult, ContinuationTaskState } from "../src/shared/continuation-plan.js";
import {
  ContinuationCurrentReadyTransitionError,
  planContinuationCurrentReadyTransition,
} from "../src/integrations/cloudflare/continuation-current-ready-transition.js";
import type {
  ContinuationCampaignRecoveryEvidence,
  DurableContinuationTaskSnapshot,
} from "../src/integrations/cloudflare/d1-continuation-campaign-reader.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const DONE_TASK_ID = "task:517";
const NEXT_TASK_ID = "task:518";
const OTHER_TASK_ID = "task:519";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const DRIFT_SHA = "2222222222222222222222222222222222222222";
const EXPECTED_HEAD_SHA = "3333333333333333333333333333333333333333";
const RESERVED_AT = "2026-08-24T15:30:00.000Z";
const READY_AT = "2026-08-24T15:31:00.000Z";
const STALE_AT = "2026-08-24T15:29:59.000Z";

interface TaskFixture {
  readonly taskId: string;
  readonly issueNumber: number;
  readonly taskState: ContinuationTaskState;
  readonly activePullRequestNumber?: number | null;
  readonly expectedHeadSha?: string | null;
  readonly priority?: number;
  readonly updatedAt?: string;
}

function task(fixture: TaskFixture): DurableContinuationTaskSnapshot {
  return {
    taskId: fixture.taskId,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    issueNumber: fixture.issueNumber,
    taskState: fixture.taskState,
    activePullRequestNumber: fixture.activePullRequestNumber ?? null,
    expectedHeadSha: fixture.expectedHeadSha ?? null,
    priority: fixture.priority ?? 10,
    updatedAt: fixture.updatedAt ?? RESERVED_AT,
  };
}

function recovery(
  options: {
    readonly nextTaskId?: string | null;
    readonly currentTaskId?: string;
    readonly currentTaskState?: ContinuationTaskState;
    readonly continueEnabled?: boolean;
    readonly paused?: boolean;
    readonly humanGate?: "MERGE" | "DEPLOY" | "NEEDS_CHANGES" | "PRODUCTION_MUTATION" | null;
    readonly expectedMainSha?: string;
    readonly observedAt?: string;
    readonly updatedAt?: string;
    readonly tasks?: readonly TaskFixture[];
  } = {},
): Extract<ContinuationCampaignRecoveryEvidence, { readonly kind: "FOUND" }> {
  const tasks = options.tasks ?? [
    { taskId: DONE_TASK_ID, issueNumber: 517, taskState: "DONE", priority: 10 },
    {
      taskId: NEXT_TASK_ID,
      issueNumber: 518,
      taskState: "DISCOVERED",
      priority: 20,
      updatedAt: RESERVED_AT,
    },
    {
      taskId: OTHER_TASK_ID,
      issueNumber: 519,
      taskState: "READY",
      priority: 30,
      updatedAt: "2026-08-24T15:20:00.000Z",
    },
  ];

  return {
    kind: "FOUND",
    campaign: {
      schemaVersion: 1,
      campaignId: CAMPAIGN_ID,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      scope: "lidl",
      mode: "CONTINUE_ISSUES",
      continueEnabled: options.continueEnabled ?? true,
      paused: options.paused ?? false,
      expectedMainSha: options.expectedMainSha ?? MAIN_SHA,
      currentTask: {
        taskId: options.currentTaskId ?? DONE_TASK_ID,
        state: options.currentTaskState ?? "DONE",
      },
      nextTaskId: options.nextTaskId === undefined ? NEXT_TASK_ID : options.nextTaskId,
      humanGate: options.humanGate ?? null,
      observedAt: options.observedAt ?? RESERVED_AT,
      updatedAt: options.updatedAt ?? RESERVED_AT,
    },
    tasks: tasks.map(task),
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
    expectedMainSha: options.expectedMainSha ?? MAIN_SHA,
    observedAt: options.observedAt ?? READY_AT,
  };
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof ContinuationCurrentReadyTransitionError && error.code === code;
}

test("reserved DISCOVERED task becomes the inert current READY unit", () => {
  const input = recovery();
  const proposal = planContinuationCurrentReadyTransition(input, ready());

  assert.equal(proposal.kind, "CURRENT_READY_TRANSITION");
  assert.deepEqual(proposal.selectionEvidence, {
    taskId: NEXT_TASK_ID,
    issueNumber: 518,
    expectedMainSha: MAIN_SHA,
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
    expectedMainSha: MAIN_SHA,
    currentTask: { taskId: NEXT_TASK_ID, state: "READY" },
    nextTaskId: null,
    humanGate: null,
    observedAt: READY_AT,
    updatedAt: READY_AT,
  });

  const completed = proposal.tasks.find((candidate) => candidate.taskId === DONE_TASK_ID);
  const selected = proposal.tasks.find((candidate) => candidate.taskId === NEXT_TASK_ID);
  const other = proposal.tasks.find((candidate) => candidate.taskId === OTHER_TASK_ID);
  assert.equal(completed?.taskState, "DONE");
  assert.equal(completed?.updatedAt, RESERVED_AT);
  assert.equal(selected?.taskState, "READY");
  assert.equal(selected?.updatedAt, READY_AT);
  assert.deepEqual(other, input.tasks.find((candidate) => candidate.taskId === OTHER_TASK_ID));

  assert.equal(input.campaign.currentTask?.taskId, DONE_TASK_ID);
  assert.equal(input.campaign.nextTaskId, NEXT_TASK_ID);
  assert.equal(input.tasks.find((candidate) => candidate.taskId === NEXT_TASK_ID)?.taskState, "DISCOVERED");
});

test("already READY reserved task stays READY and receives the fresh observation time", () => {
  const input = recovery({
    tasks: [
      { taskId: DONE_TASK_ID, issueNumber: 517, taskState: "DONE", priority: 10 },
      { taskId: NEXT_TASK_ID, issueNumber: 518, taskState: "READY", priority: 20 },
    ],
  });
  const proposal = planContinuationCurrentReadyTransition(input, ready());
  const selected = proposal.tasks.find((candidate) => candidate.taskId === NEXT_TASK_ID);

  assert.equal(selected?.taskState, "READY");
  assert.equal(selected?.updatedAt, READY_AT);
});

test("durable FOUND evidence and fresh READY plan are both required", () => {
  assert.throws(
    () => planContinuationCurrentReadyTransition({ kind: "NOT_FOUND" }, ready()),
    expectCode("FOUND_RECOVERY_REQUIRED"),
  );
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery(), { kind: "NO_ELIGIBLE_TASK" }),
    expectCode("READY_PLAN_REQUIRED"),
  );
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery(), { kind: "PAUSED" }),
    expectCode("READY_PLAN_REQUIRED"),
  );
});

test("reserved campaign must remain enabled, unpaused, ungated and post-merge DONE", () => {
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery({ continueEnabled: false }), ready()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery({ paused: true }), ready()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery({ humanGate: "MERGE" }), ready()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery({ currentTaskState: "MERGE_READY" }), ready()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery({ currentTaskId: NEXT_TASK_ID }), ready()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
});

test("fresh READY identity must exactly match campaign, main and durable reservation", () => {
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery(), ready({ campaignId: "campaign:other" })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery(), ready({ repository: "rozkalnsandris/hermes-tech" })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery(), ready({ taskId: OTHER_TASK_ID, issueNumber: 519 })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery(), ready({ expectedMainSha: DRIFT_SHA })),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
});

test("reserved task must still be selectable and have no PR/head evidence", () => {
  const working = recovery({
    tasks: [
      { taskId: DONE_TASK_ID, issueNumber: 517, taskState: "DONE" },
      { taskId: NEXT_TASK_ID, issueNumber: 518, taskState: "WORKING" },
    ],
  });
  assert.throws(
    () => planContinuationCurrentReadyTransition(working, ready()),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );

  const withPull = recovery({
    tasks: [
      { taskId: DONE_TASK_ID, issueNumber: 517, taskState: "DONE" },
      {
        taskId: NEXT_TASK_ID,
        issueNumber: 518,
        taskState: "READY",
        activePullRequestNumber: 601,
        expectedHeadSha: EXPECTED_HEAD_SHA,
      },
    ],
  });
  assert.throws(
    () => planContinuationCurrentReadyTransition(withPull, ready()),
    expectCode("READY_EVIDENCE_MISMATCH"),
  );
});

test("fresh READY observation cannot predate reservation or selected-task evidence", () => {
  assert.throws(
    () => planContinuationCurrentReadyTransition(recovery(), ready({ observedAt: STALE_AT })),
    expectCode("STALE_READY_EVIDENCE"),
  );

  const newerSelected = recovery({
    tasks: [
      { taskId: DONE_TASK_ID, issueNumber: 517, taskState: "DONE" },
      {
        taskId: NEXT_TASK_ID,
        issueNumber: 518,
        taskState: "DISCOVERED",
        updatedAt: "2026-08-24T15:31:01.000Z",
      },
    ],
  });
  assert.throws(
    () => planContinuationCurrentReadyTransition(newerSelected, ready()),
    expectCode("STALE_READY_EVIDENCE"),
  );
});

test("duplicate task, issue or PR evidence fails closed", () => {
  const duplicateTask = recovery({
    tasks: [
      { taskId: DONE_TASK_ID, issueNumber: 517, taskState: "DONE" },
      { taskId: NEXT_TASK_ID, issueNumber: 518, taskState: "DISCOVERED" },
      { taskId: NEXT_TASK_ID, issueNumber: 519, taskState: "READY" },
    ],
  });
  assert.throws(
    () => planContinuationCurrentReadyTransition(duplicateTask, ready()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );

  const duplicatePull = recovery({
    tasks: [
      {
        taskId: DONE_TASK_ID,
        issueNumber: 517,
        taskState: "DONE",
        activePullRequestNumber: 600,
        expectedHeadSha: EXPECTED_HEAD_SHA,
      },
      { taskId: NEXT_TASK_ID, issueNumber: 518, taskState: "DISCOVERED" },
      {
        taskId: OTHER_TASK_ID,
        issueNumber: 519,
        taskState: "WAITING",
        activePullRequestNumber: 600,
        expectedHeadSha: EXPECTED_HEAD_SHA,
      },
    ],
  });
  assert.throws(
    () => planContinuationCurrentReadyTransition(duplicatePull, ready()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
});

test("current READY transition remains pure and detached from persistence/runtime execution", () => {
  const source = readFileSync(
    resolve("src/integrations/cloudflare/continuation-current-ready-transition.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /\.prepare\s*\(/u);
  assert.doesNotMatch(source, /\bD1DatabaseLike\b/u);
  assert.doesNotMatch(source, /\bD1ContinuationNextTaskStore\b/u);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
  assert.doesNotMatch(source, /\b(?:fetch|send|enqueue|schedule|deploy|persist|write)\s*\(/u);
  assert.doesNotMatch(source, /continuation-runtime/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:worker|queue|notification|store)/u);
});
