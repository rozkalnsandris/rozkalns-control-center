import {
  MAX_CONTINUATION_CANDIDATES,
  type ContinuationTaskState,
} from "../../shared/continuation-plan.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import type {
  ContinuationCampaignRecoveryEvidence,
  DurableContinuationCampaignSnapshot,
  DurableContinuationTaskSnapshot,
} from "./d1-continuation-campaign-reader.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
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

export interface ContinuationCurrentWorkingEvidence {
  readonly campaignId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly taskId: string;
  readonly issueNumber: number;
  readonly expectedMainSha: string;
  readonly observedAt: string;
}

export interface ContinuationCurrentWorkingTransitionProposal {
  readonly schemaVersion: 1;
  readonly kind: "CURRENT_WORKING_TRANSITION";
  readonly transitionEvidence: ContinuationCurrentWorkingEvidence;
  readonly campaign: DurableContinuationCampaignSnapshot;
  readonly tasks: readonly DurableContinuationTaskSnapshot[];
}

export type ContinuationCurrentWorkingTransitionErrorCode =
  | "INVALID_INPUT"
  | "FOUND_RECOVERY_REQUIRED"
  | "CAMPAIGN_EVIDENCE_MISMATCH"
  | "WORKING_EVIDENCE_MISMATCH"
  | "STALE_WORKING_EVIDENCE";

export class ContinuationCurrentWorkingTransitionError extends Error {
  readonly code: ContinuationCurrentWorkingTransitionErrorCode;

  constructor(code: ContinuationCurrentWorkingTransitionErrorCode) {
    super("Continuation current WORKING transition failed closed");
    this.name = "ContinuationCurrentWorkingTransitionError";
    this.code = code;
  }
}

function fail(code: ContinuationCurrentWorkingTransitionErrorCode): never {
  throw new ContinuationCurrentWorkingTransitionError(code);
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) fail("INVALID_INPUT");
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireSha(value: unknown): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail("INVALID_INPUT");
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
 * Represent one already-current READY task as inert WORKING state evidence.
 *
 * This pure function does not persist, dispatch, schedule, start or execute the
 * task. WORKING is normalized transition evidence only and grants no authority
 * for GitHub mutation, merge, deployment, database writes or host execution.
 */
export function planContinuationCurrentWorkingTransition(
  recovery: ContinuationCampaignRecoveryEvidence,
  evidence: ContinuationCurrentWorkingEvidence,
): ContinuationCurrentWorkingTransitionProposal {
  if (!recovery || typeof recovery !== "object" || !evidence || typeof evidence !== "object") {
    fail("INVALID_INPUT");
  }
  if (recovery.kind !== "FOUND") fail("FOUND_RECOVERY_REQUIRED");

  const campaign = recovery.campaign;
  if (!campaign || typeof campaign !== "object" || campaign.schemaVersion !== 1) {
    fail("INVALID_INPUT");
  }

  const campaignId = requireIdentifier(campaign.campaignId);
  const projectId = requireIdentifier(campaign.projectId);
  const expectedMainSha = requireSha(campaign.expectedMainSha);
  const campaignObservedAt = requireCanonicalUtc(campaign.observedAt);
  const campaignUpdatedAt = requireCanonicalUtc(campaign.updatedAt);

  let policy;
  try {
    policy = requireManagedProjectPolicy(campaign.repository);
  } catch {
    fail("CAMPAIGN_EVIDENCE_MISMATCH");
  }

  if (
    campaign.repository !== policy.repository ||
    projectId !== policy.id ||
    typeof campaign.scope !== "string" ||
    campaign.scope.length === 0 ||
    campaign.mode !== "CONTINUE_ISSUES" ||
    campaign.continueEnabled !== true ||
    campaign.paused !== false ||
    campaign.humanGate !== null ||
    campaign.nextTaskId !== null ||
    campaign.currentTask === null ||
    campaign.currentTask.state !== "READY" ||
    Date.parse(campaignUpdatedAt) < Date.parse(campaignObservedAt)
  ) {
    fail("CAMPAIGN_EVIDENCE_MISMATCH");
  }

  const currentTaskId = requireIdentifier(campaign.currentTask.taskId);
  const evidenceCampaignId = requireIdentifier(evidence.campaignId);
  const evidenceProjectId = requireIdentifier(evidence.projectId);
  const evidenceTaskId = requireIdentifier(evidence.taskId);
  const evidenceIssueNumber = requirePositiveInteger(evidence.issueNumber);
  const evidenceMainSha = requireSha(evidence.expectedMainSha);
  const workingObservedAt = requireCanonicalUtc(evidence.observedAt);

  if (
    evidenceCampaignId !== campaignId ||
    evidenceProjectId !== projectId ||
    evidence.repository !== campaign.repository ||
    evidenceTaskId !== currentTaskId ||
    evidenceMainSha !== expectedMainSha
  ) {
    fail("WORKING_EVIDENCE_MISMATCH");
  }
  if (
    Date.parse(workingObservedAt) < Date.parse(campaignObservedAt) ||
    Date.parse(workingObservedAt) < Date.parse(campaignUpdatedAt)
  ) {
    fail("STALE_WORKING_EVIDENCE");
  }

  if (!Array.isArray(recovery.tasks) || recovery.tasks.length > MAX_CONTINUATION_CANDIDATES) {
    fail("INVALID_INPUT");
  }

  const taskIds = new Set<string>();
  const issueNumbers = new Set<number>();
  const pullRequestNumbers = new Set<number>();
  let currentTask: DurableContinuationTaskSnapshot | null = null;

  for (const task of recovery.tasks) {
    if (!task || typeof task !== "object") fail("INVALID_INPUT");
    const taskId = requireIdentifier(task.taskId);
    const issueNumber = requirePositiveInteger(task.issueNumber);
    requireTaskState(task.taskState);
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

    if (Date.parse(updatedAt) > Date.parse(workingObservedAt)) {
      fail("STALE_WORKING_EVIDENCE");
    }
    if (taskId === currentTaskId) currentTask = task;
  }

  if (currentTask === null) fail("CAMPAIGN_EVIDENCE_MISMATCH");
  if (
    currentTask.issueNumber !== evidenceIssueNumber ||
    currentTask.taskState !== "READY" ||
    currentTask.activePullRequestNumber !== null ||
    currentTask.expectedHeadSha !== null
  ) {
    fail("WORKING_EVIDENCE_MISMATCH");
  }

  const tasks = recovery.tasks.map((task) => {
    if (task.taskId !== currentTaskId) return cloneTask(task);
    return {
      ...cloneTask(task),
      taskState: "WORKING" as const,
      updatedAt: workingObservedAt,
    };
  });

  return {
    schemaVersion: 1,
    kind: "CURRENT_WORKING_TRANSITION",
    transitionEvidence: {
      campaignId,
      projectId,
      repository: campaign.repository,
      taskId: currentTaskId,
      issueNumber: evidenceIssueNumber,
      expectedMainSha,
      observedAt: workingObservedAt,
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
      currentTask: { taskId: currentTaskId, state: "WORKING" },
      nextTaskId: null,
      humanGate: null,
      observedAt: workingObservedAt,
      updatedAt: workingObservedAt,
    },
    tasks,
  };
}
