import {
  MAX_CONTINUATION_CANDIDATES,
  type ContinuationPlanResult,
  type ContinuationTaskState,
} from "../../shared/continuation-plan.js";
import type {
  ContinuationCampaignRecoveryEvidence,
  DurableContinuationCampaignSnapshot,
  DurableContinuationTaskSnapshot,
} from "./d1-continuation-campaign-reader.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SELECTABLE_TASK_STATES = new Set<ContinuationTaskState>(["DISCOVERED", "READY"]);
const TASK_STATES = new Set<ContinuationTaskState>([
  "DISCOVERED",
  "READY",
  "WORKING",
  "WAITING",
  "PR_DRAFT",
  "WAIT_CI",
  "REVIEW",
  "NEEDS_ANDRIS",
  "MERGE_READY",
  "MERGED",
  "DEPLOY_DECISION",
  "PRODUCTION_VERIFY",
  "DONE",
  "PAUSED",
  "BLOCKED",
  "CI_FAILED",
  "CANCELLED",
]);

export interface ContinuationCurrentReadyTransitionProposal {
  readonly schemaVersion: 1;
  readonly kind: "CURRENT_READY_TRANSITION";
  readonly selectionEvidence: {
    readonly taskId: string;
    readonly issueNumber: number;
    readonly expectedMainSha: string;
    readonly observedAt: string;
  };
  readonly campaign: DurableContinuationCampaignSnapshot;
  readonly tasks: readonly DurableContinuationTaskSnapshot[];
}

export type ContinuationCurrentReadyTransitionErrorCode =
  | "INVALID_INPUT"
  | "FOUND_RECOVERY_REQUIRED"
  | "READY_PLAN_REQUIRED"
  | "CAMPAIGN_EVIDENCE_MISMATCH"
  | "READY_EVIDENCE_MISMATCH"
  | "STALE_READY_EVIDENCE";

export class ContinuationCurrentReadyTransitionError extends Error {
  readonly code: ContinuationCurrentReadyTransitionErrorCode;

  constructor(code: ContinuationCurrentReadyTransitionErrorCode) {
    super("Continuation current READY transition failed closed");
    this.name = "ContinuationCurrentReadyTransitionError";
    this.code = code;
  }
}

function fail(code: ContinuationCurrentReadyTransitionErrorCode): never {
  throw new ContinuationCurrentReadyTransitionError(code);
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) fail("INVALID_INPUT");
  return value;
}

function requireSha(value: unknown): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail("INVALID_INPUT");
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireCanonicalUtc(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireTaskState(value: unknown): ContinuationTaskState {
  if (typeof value !== "string" || !TASK_STATES.has(value as ContinuationTaskState)) {
    fail("INVALID_INPUT");
  }
  return value as ContinuationTaskState;
}

function cloneTask(task: DurableContinuationTaskSnapshot): DurableContinuationTaskSnapshot {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    repository: task.repository,
    issueNumber: task.issueNumber,
    taskState: task.taskState,
    activePullRequestNumber: task.activePullRequestNumber,
    expectedHeadSha: task.expectedHeadSha,
    priority: task.priority,
    updatedAt: task.updatedAt,
  };
}

/**
 * Claim one already-reserved next task as the inert current READY unit.
 *
 * This pure function does not persist, schedule or start the task. READY means
 * deterministic state evidence only and grants no authority for later work.
 */
export function planContinuationCurrentReadyTransition(
  recovery: ContinuationCampaignRecoveryEvidence,
  plan: ContinuationPlanResult,
): ContinuationCurrentReadyTransitionProposal {
  if (!recovery || typeof recovery !== "object" || !plan || typeof plan !== "object") {
    fail("INVALID_INPUT");
  }
  if (recovery.kind !== "FOUND") fail("FOUND_RECOVERY_REQUIRED");
  if (plan.kind !== "READY") fail("READY_PLAN_REQUIRED");

  const campaign = recovery.campaign;
  if (!campaign || typeof campaign !== "object" || campaign.schemaVersion !== 1) {
    fail("INVALID_INPUT");
  }

  const campaignId = requireIdentifier(campaign.campaignId);
  const projectId = requireIdentifier(campaign.projectId);
  const expectedMainSha = requireSha(campaign.expectedMainSha);
  const nextTaskId = requireIdentifier(campaign.nextTaskId);
  const campaignObservedAt = requireCanonicalUtc(campaign.observedAt);
  const campaignUpdatedAt = requireCanonicalUtc(campaign.updatedAt);

  if (
    typeof campaign.repository !== "string" ||
    campaign.repository.length === 0 ||
    typeof campaign.scope !== "string" ||
    campaign.scope.length === 0 ||
    campaign.mode !== "CONTINUE_ISSUES" ||
    campaign.continueEnabled !== true ||
    campaign.paused !== false ||
    campaign.humanGate !== null ||
    campaign.currentTask === null ||
    campaign.currentTask.state !== "DONE" ||
    campaign.currentTask.taskId === nextTaskId ||
    Date.parse(campaignUpdatedAt) < Date.parse(campaignObservedAt)
  ) {
    fail("CAMPAIGN_EVIDENCE_MISMATCH");
  }
  const completedTaskId = requireIdentifier(campaign.currentTask.taskId);

  const readyTaskId = requireIdentifier(plan.taskId);
  const readyIssueNumber = requirePositiveInteger(plan.issueNumber);
  const readyMainSha = requireSha(plan.expectedMainSha);
  const readyObservedAt = requireCanonicalUtc(plan.observedAt);
  if (
    plan.campaignId !== campaignId ||
    plan.projectId !== projectId ||
    plan.repository !== campaign.repository ||
    readyTaskId !== nextTaskId ||
    readyMainSha !== expectedMainSha
  ) {
    fail("READY_EVIDENCE_MISMATCH");
  }
  if (
    Date.parse(readyObservedAt) < Date.parse(campaignObservedAt) ||
    Date.parse(readyObservedAt) < Date.parse(campaignUpdatedAt)
  ) {
    fail("STALE_READY_EVIDENCE");
  }

  if (!Array.isArray(recovery.tasks) || recovery.tasks.length > MAX_CONTINUATION_CANDIDATES) {
    fail("INVALID_INPUT");
  }

  const taskIds = new Set<string>();
  const issueNumbers = new Set<number>();
  const pullRequestNumbers = new Set<number>();
  let completedTaskMatches = 0;
  let selectedTask: DurableContinuationTaskSnapshot | null = null;

  for (const task of recovery.tasks) {
    if (!task || typeof task !== "object") fail("INVALID_INPUT");
    const taskId = requireIdentifier(task.taskId);
    const issueNumber = requirePositiveInteger(task.issueNumber);
    const taskState = requireTaskState(task.taskState);
    const updatedAt = requireCanonicalUtc(task.updatedAt);

    if (
      task.projectId !== projectId ||
      task.repository !== campaign.repository ||
      !Number.isSafeInteger(task.priority) ||
      task.priority < 0 ||
      task.priority > 1_000_000
    ) {
      fail("CAMPAIGN_EVIDENCE_MISMATCH");
    }
    if (taskIds.has(taskId) || issueNumbers.has(issueNumber)) {
      fail("CAMPAIGN_EVIDENCE_MISMATCH");
    }
    taskIds.add(taskId);
    issueNumbers.add(issueNumber);

    const hasPullRequest = task.activePullRequestNumber !== null;
    const hasExpectedHead = task.expectedHeadSha !== null;
    if (hasPullRequest !== hasExpectedHead) fail("CAMPAIGN_EVIDENCE_MISMATCH");
    if (task.expectedHeadSha !== null) requireSha(task.expectedHeadSha);
    if (task.activePullRequestNumber !== null) {
      const pullRequestNumber = requirePositiveInteger(task.activePullRequestNumber);
      if (pullRequestNumbers.has(pullRequestNumber)) fail("CAMPAIGN_EVIDENCE_MISMATCH");
      pullRequestNumbers.add(pullRequestNumber);
    }

    if (taskId === completedTaskId) {
      completedTaskMatches += 1;
      if (taskState !== "DONE") fail("CAMPAIGN_EVIDENCE_MISMATCH");
    }
    if (taskId === nextTaskId) selectedTask = task;

    if (Date.parse(updatedAt) > Date.parse(readyObservedAt) && taskId === nextTaskId) {
      fail("STALE_READY_EVIDENCE");
    }
  }

  if (completedTaskMatches !== 1 || selectedTask === null) {
    fail("CAMPAIGN_EVIDENCE_MISMATCH");
  }
  if (
    selectedTask.issueNumber !== readyIssueNumber ||
    !SELECTABLE_TASK_STATES.has(selectedTask.taskState) ||
    selectedTask.activePullRequestNumber !== null ||
    selectedTask.expectedHeadSha !== null
  ) {
    fail("READY_EVIDENCE_MISMATCH");
  }

  const tasks = recovery.tasks.map((task) => {
    if (task.taskId !== nextTaskId) return cloneTask(task);
    return {
      ...cloneTask(task),
      taskState: "READY" as const,
      updatedAt: readyObservedAt,
    };
  });

  return {
    schemaVersion: 1,
    kind: "CURRENT_READY_TRANSITION",
    selectionEvidence: {
      taskId: nextTaskId,
      issueNumber: readyIssueNumber,
      expectedMainSha,
      observedAt: readyObservedAt,
    },
    campaign: {
      schemaVersion: 1,
      campaignId,
      projectId,
      repository: campaign.repository,
      scope: campaign.scope,
      mode: "CONTINUE_ISSUES",
      continueEnabled: true,
      paused: false,
      expectedMainSha,
      currentTask: { taskId: nextTaskId, state: "READY" },
      nextTaskId: null,
      humanGate: null,
      observedAt: readyObservedAt,
      updatedAt: readyObservedAt,
    },
    tasks,
  };
}
