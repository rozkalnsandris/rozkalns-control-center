import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { ContinuationTaskState } from "../src/shared/continuation-plan.js";
import {
  ContinuationCurrentWorkingTransitionError,
  planContinuationCurrentWorkingTransition,
  type ContinuationCurrentWorkingEvidence,
} from "../src/integrations/cloudflare/continuation-current-working-transition.js";
import type {
  ContinuationCampaignRecoveryEvidence,
  DurableContinuationTaskSnapshot,
} from "../src/integrations/cloudflare/d1-continuation-campaign-reader.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const CURRENT_TASK_ID = "task:518";
const OTHER_TASK_ID = "task:517";
const THIRD_TASK_ID = "task:519";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const DRIFT_SHA = "2222222222222222222222222222222222222222";
const EXPECTED_HEAD_SHA = "3333333333333333333333333333333333333333";
const READY_AT = "2026-08-24T18:45:00.000Z";
const WORKING_AT = "2026-08-24T18:46:00.000Z";
const STALE_AT = "2026-08-24T18:44:59.000Z";

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
    updatedAt: fixture.updatedAt ?? READY_AT,
  };
}

function recovery(
  options: {
    readonly currentTaskId?: string;
    readonly currentTaskState?: ContinuationTaskState;
    readonly nextTaskId?: string | null;
    readonly continueEnabled?: boolean;
    readonly paused?: boolean;
    readonly humanGate?: "MERGE" | "DEPLOY" | "NEEDS_CHANGES" | "PRODUCTION_MUTATION" | null;
    readonly expectedMainSha?: string;
    readonly observedAt?: string;
    readonly updatedAt?: string;
    readonly repository?: string;
    readonly projectId?: string;
    readonly tasks?: readonly TaskFixture[];
  } = {},
): Extract<ContinuationCampaignRecoveryEvidence, { readonly kind: "FOUND" }> {
  const repository = options.repository ?? REPOSITORY;
  const projectId = options.projectId ?? PROJECT_ID;
  const tasks = options.tasks ?? [
    { taskId: OTHER_TASK_ID, issueNumber: 517, taskState: "DONE", priority: 10 },
    { taskId: CURRENT_TASK_ID, issueNumber: 518, taskState: "READY", priority: 20 },
    { taskId: THIRD_TASK_ID, issueNumber: 519, taskState: "DISCOVERED", priority: 30 },
  ];

  return {
    kind: "FOUND",
    campaign: {
      schemaVersion: 1,
      campaignId: CAMPAIGN_ID,
      projectId,
      repository,
      scope: "lidl",
      mode: "CONTINUE_ISSUES",
      continueEnabled: options.continueEnabled ?? true,
      paused: options.paused ?? false,
      expectedMainSha: options.expectedMainSha ?? MAIN_SHA,
      currentTask: {
        taskId: options.currentTaskId ?? CURRENT_TASK_ID,
        state: options.currentTaskState ?? "READY",
      },
      nextTaskId: options.nextTaskId ?? null,
      humanGate: options.humanGate ?? null,
      observedAt: options.observedAt ?? READY_AT,
      updatedAt: options.updatedAt ?? READY_AT,
    },
    tasks: tasks.map((fixture) => ({ ...task(fixture), repository, projectId })),
  };
}

function evidence(
  options: Partial<ContinuationCurrentWorkingEvidence> = {},
): ContinuationCurrentWorkingEvidence {
  return {
    campaignId: options.campaignId ?? CAMPAIGN_ID,
    projectId: options.projectId ?? PROJECT_ID,
    repository: options.repository ?? REPOSITORY,
    taskId: options.taskId ?? CURRENT_TASK_ID,
    issueNumber: options.issueNumber ?? 518,
    expectedMainSha: options.expectedMainSha ?? MAIN_SHA,
    observedAt: options.observedAt ?? WORKING_AT,
  };
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof ContinuationCurrentWorkingTransitionError && error.code === code;
}

test("current READY task becomes inert WORKING evidence and unrelated tasks are preserved", () => {
  const input = recovery();
  const proposal = planContinuationCurrentWorkingTransition(input, evidence());

  assert.equal(proposal.kind, "CURRENT_WORKING_TRANSITION");
  assert.deepEqual(proposal.transitionEvidence, {
    campaignId: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    taskId: CURRENT_TASK_ID,
    issueNumber: 518,
    expectedMainSha: MAIN_SHA,
    observedAt: WORKING_AT,
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
    currentTask: { taskId: CURRENT_TASK_ID, state: "WORKING" },
    nextTaskId: null,
    humanGate: null,
    observedAt: WORKING_AT,
    updatedAt: WORKING_AT,
  });

  const selected = proposal.tasks.find((candidate) => candidate.taskId === CURRENT_TASK_ID);
  assert.equal(selected?.taskState, "WORKING");
  assert.equal(selected?.updatedAt, WORKING_AT);
  assert.deepEqual(
    proposal.tasks.find((candidate) => candidate.taskId === OTHER_TASK_ID),
    input.tasks.find((candidate) => candidate.taskId === OTHER_TASK_ID),
  );
  assert.deepEqual(
    proposal.tasks.find((candidate) => candidate.taskId === THIRD_TASK_ID),
    input.tasks.find((candidate) => candidate.taskId === THIRD_TASK_ID),
  );

  assert.equal(input.campaign.currentTask?.state, "READY");
  assert.equal(input.tasks.find((candidate) => candidate.taskId === CURRENT_TASK_ID)?.taskState, "READY");
});

test("FOUND current READY durable evidence is required", () => {
  assert.throws(
    () => planContinuationCurrentWorkingTransition({ kind: "NOT_FOUND" }, evidence()),
    expectCode("FOUND_RECOVERY_REQUIRED"),
  );
});

test("campaign must remain managed, enabled, unpaused, ungated and current READY", () => {
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery({ continueEnabled: false }), evidence()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery({ paused: true }), evidence()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery({ humanGate: "MERGE" }), evidence()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery({ currentTaskState: "WORKING" }), evidence()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery({ nextTaskId: THIRD_TASK_ID }), evidence()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () =>
      planContinuationCurrentWorkingTransition(
        recovery({ repository: "rozkalnsandris/hermes-email-skill", projectId: "hermes-email-skill" }),
        evidence({ repository: "rozkalnsandris/hermes-email-skill", projectId: "hermes-email-skill" }),
      ),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
});

test("WORKING evidence must bind exact campaign, project, repository, task, issue and main", () => {
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery(), evidence({ campaignId: "campaign:other" })),
    expectCode("WORKING_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery(), evidence({ projectId: "hermes-tech" })),
    expectCode("WORKING_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () =>
      planContinuationCurrentWorkingTransition(
        recovery(),
        evidence({ repository: "rozkalnsandris/hermes-tech" }),
      ),
    expectCode("WORKING_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery(), evidence({ taskId: THIRD_TASK_ID })),
    expectCode("WORKING_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery(), evidence({ issueNumber: 519 })),
    expectCode("WORKING_EVIDENCE_MISMATCH"),
  );
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery(), evidence({ expectedMainSha: DRIFT_SHA })),
    expectCode("WORKING_EVIDENCE_MISMATCH"),
  );
});

test("current task row must still be READY with no PR/head evidence", () => {
  const progressed = recovery({
    tasks: [
      { taskId: OTHER_TASK_ID, issueNumber: 517, taskState: "DONE" },
      { taskId: CURRENT_TASK_ID, issueNumber: 518, taskState: "WORKING" },
    ],
  });
  assert.throws(
    () => planContinuationCurrentWorkingTransition(progressed, evidence()),
    expectCode("WORKING_EVIDENCE_MISMATCH"),
  );

  const withPull = recovery({
    tasks: [
      { taskId: OTHER_TASK_ID, issueNumber: 517, taskState: "DONE" },
      {
        taskId: CURRENT_TASK_ID,
        issueNumber: 518,
        taskState: "READY",
        activePullRequestNumber: 601,
        expectedHeadSha: EXPECTED_HEAD_SHA,
      },
    ],
  });
  assert.throws(
    () => planContinuationCurrentWorkingTransition(withPull, evidence()),
    expectCode("WORKING_EVIDENCE_MISMATCH"),
  );
});

test("WORKING observation cannot predate campaign or any durable task evidence", () => {
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery(), evidence({ observedAt: STALE_AT })),
    expectCode("STALE_WORKING_EVIDENCE"),
  );

  const newerTask = recovery({
    tasks: [
      { taskId: OTHER_TASK_ID, issueNumber: 517, taskState: "DONE" },
      { taskId: CURRENT_TASK_ID, issueNumber: 518, taskState: "READY" },
      {
        taskId: THIRD_TASK_ID,
        issueNumber: 519,
        taskState: "DISCOVERED",
        updatedAt: "2026-08-24T18:46:01.000Z",
      },
    ],
  });
  assert.throws(
    () => planContinuationCurrentWorkingTransition(newerTask, evidence()),
    expectCode("STALE_WORKING_EVIDENCE"),
  );
});

test("duplicate task, issue or PR evidence fails closed", () => {
  const duplicateTask = recovery({
    tasks: [
      { taskId: CURRENT_TASK_ID, issueNumber: 518, taskState: "READY" },
      { taskId: CURRENT_TASK_ID, issueNumber: 519, taskState: "DISCOVERED" },
    ],
  });
  assert.throws(
    () => planContinuationCurrentWorkingTransition(duplicateTask, evidence()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );

  const duplicateIssue = recovery({
    tasks: [
      { taskId: CURRENT_TASK_ID, issueNumber: 518, taskState: "READY" },
      { taskId: THIRD_TASK_ID, issueNumber: 518, taskState: "DISCOVERED" },
    ],
  });
  assert.throws(
    () => planContinuationCurrentWorkingTransition(duplicateIssue, evidence()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );

  const duplicatePull = recovery({
    tasks: [
      { taskId: CURRENT_TASK_ID, issueNumber: 518, taskState: "READY" },
      {
        taskId: OTHER_TASK_ID,
        issueNumber: 517,
        taskState: "DONE",
        activePullRequestNumber: 600,
        expectedHeadSha: EXPECTED_HEAD_SHA,
      },
      {
        taskId: THIRD_TASK_ID,
        issueNumber: 519,
        taskState: "WAITING",
        activePullRequestNumber: 600,
        expectedHeadSha: EXPECTED_HEAD_SHA,
      },
    ],
  });
  assert.throws(
    () => planContinuationCurrentWorkingTransition(duplicatePull, evidence()),
    expectCode("CAMPAIGN_EVIDENCE_MISMATCH"),
  );
});

test("malformed transition observation fails closed", () => {
  assert.throws(
    () => planContinuationCurrentWorkingTransition(recovery(), evidence({ observedAt: "2026-08-24" })),
    expectCode("INVALID_INPUT"),
  );
});

test("current WORKING proposal remains detached from persistence, runtime and execution", () => {
  const source = readFileSync(
    resolve("src/integrations/cloudflare/continuation-current-working-transition.ts"),
    "utf8",
  );
  const runtimeSource = readFileSync(
    resolve("src/integrations/cloudflare/continuation-runtime.ts"),
    "utf8",
  );
  const workerSource = readFileSync(resolve("src/worker/index.ts"), "utf8");
  const wranglerSource = readFileSync(resolve("wrangler.jsonc"), "utf8");

  assert.doesNotMatch(source, /\.prepare\s*\(/u);
  assert.doesNotMatch(source, /\bD1DatabaseLike\b/u);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
  assert.doesNotMatch(source, /\b(?:fetch|send|enqueue|schedule|dispatch|deploy|persist|write)\s*\(/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:worker|queue|notification|store|runtime)/u);
  assert.doesNotMatch(runtimeSource, /continuation-current-working-transition/u);
  assert.doesNotMatch(workerSource, /continuation-current-working-transition/u);
  assert.doesNotMatch(wranglerSource, /CURRENT_WORKING_TRANSITION/u);
});
