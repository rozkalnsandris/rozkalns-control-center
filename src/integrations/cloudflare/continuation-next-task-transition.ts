import type {
  ContinuationPlanResult,
  ContinuationTaskState,
} from "../../shared/continuation-plan.js";
import type { ContinuationPostMergeTransitionProposal } from "./continuation-post-merge-transition.js";

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
const SELECTABLE_TASK_STATES = new Set<ContinuationTaskState>(["DISCOVERED", "READY"]);

type TransitionTask = ContinuationPostMergeTransitionProposal["tasks"][number];

export interface ContinuationNextTaskTransitionProposal {
  readonly schemaVersion: 1;
  readonly kind: "NEXT_TASK_TRANSITION";
  readonly selectionEvidence: {
    readonly taskId: string;
    readonly issueNumber: number;
    readonly expectedMainSha: string;
    readonly observedAt: string;
  };
  readonly campaign: ContinuationPostMergeTransitionProposal["campaign"];
  readonly tasks: readonly TransitionTask[];
}

export type ContinuationNextTaskTransitionErrorCode =
  | "INVALID_INPUT"
  | "READY_PLAN_REQUIRED"
  | "TRANSITION_EVIDENCE_MISMATCH"
  | "READY_EVIDENCE_MISMATCH"
  | "STALE_READY_EVIDENCE";

export class ContinuationNextTaskTransitionError extends Error {
  readonly code: ContinuationNextTaskTransitionErrorCode;

  constructor(code: ContinuationNextTaskTransitionErrorCode) {
    super("Continuation next-task transition failed closed");
    this.name = "ContinuationNextTaskTransitionError";
    this.code = code;
  }
}

function fail(code: ContinuationNextTaskTransitionErrorCode): never {
  throw new ContinuationNextTaskTransitionError(code);
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

function cloneTask(task: TransitionTask): TransitionTask {
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
 * Bind one already-authoritative READY selection into inert durable-state evidence.
 *
 * The selected task is reserved only as nextTaskId. This function deliberately
 * does not make it current, change its task state, persist anything, schedule
 * work, notify, merge, deploy, or grant authority for any later mutation.
 */
export function planContinuationNextTaskTransition(
  transition: ContinuationPostMergeTransitionProposal,
  plan: ContinuationPlanResult,
): ContinuationNextTaskTransitionProposal {
  if (!transition || typeof transition !== "object" || !plan || typeof plan !== "object") {
    fail("INVALID_INPUT");
  }
  if (transition.schemaVersion !== 1 || transition.kind !== "POST_MERGE_TRANSITION") {
    fail("INVALID_INPUT");
  }
  if (plan.kind !== "READY") fail("READY_PLAN_REQUIRED");

  const campaign = transition.campaign;
  const mergeEvidence = transition.mergeEvidence;
  if (!campaign || typeof campaign !== "object" || !mergeEvidence || typeof mergeEvidence !== "object") {
    fail("INVALID_INPUT");
  }
  if (campaign.schemaVersion !== 1 || mergeEvidence.merged !== true) fail("INVALID_INPUT");

  const campaignId = requireIdentifier(campaign.campaignId);
  const projectId = requireIdentifier(campaign.projectId);
  const mergedTaskId = requireIdentifier(mergeEvidence.taskId);
  const selectedTaskId = requireIdentifier(plan.taskId);
  const mergedIssueNumber = requirePositiveInteger(mergeEvidence.issueNumber);
  requirePositiveInteger(mergeEvidence.pullRequestNumber);
  requireSha(mergeEvidence.expectedHeadSha);
  const previousMainSha = requireSha(mergeEvidence.previousMainSha);
  const mergeSha = requireSha(mergeEvidence.mergeSha);
  const transitionObservedAt = requireCanonicalUtc(mergeEvidence.observedAt);
  const selectedIssueNumber = requirePositiveInteger(plan.issueNumber);
  const readyMainSha = requireSha(plan.expectedMainSha);
  const readyObservedAt = requireCanonicalUtc(plan.observedAt);

  if (typeof campaign.repository !== "string" || campaign.repository.length === 0) {
    fail("INVALID_INPUT");
  }
  if (typeof campaign.scope !== "string" || campaign.scope.length === 0) fail("INVALID_INPUT");
  if (campaign.mode !== "CONTINUE_ISSUES") fail("TRANSITION_EVIDENCE_MISMATCH");
  if (typeof campaign.continueEnabled !== "boolean" || typeof campaign.paused !== "boolean") {
    fail("INVALID_INPUT");
  }
  if (!campaign.continueEnabled || campaign.paused) fail("TRANSITION_EVIDENCE_MISMATCH");

  if (
    plan.campaignId !== campaignId ||
    plan.projectId !== projectId ||
    plan.repository !== campaign.repository
  ) {
    fail("READY_EVIDENCE_MISMATCH");
  }
  if (
    readyMainSha !== mergeSha ||
    requireSha(campaign.expectedMainSha) !== mergeSha ||
    previousMainSha === mergeSha
  ) {
    fail("READY_EVIDENCE_MISMATCH");
  }
  if (selectedTaskId === mergedTaskId) fail("READY_EVIDENCE_MISMATCH");

  if (
    campaign.currentTask === null ||
    campaign.currentTask.taskId !== mergedTaskId ||
    campaign.currentTask.state !== "DONE" ||
    campaign.nextTaskId !== null ||
    campaign.humanGate !== null
  ) {
    fail("TRANSITION_EVIDENCE_MISMATCH");
  }
  if (
    requireCanonicalUtc(campaign.observedAt) !== transitionObservedAt ||
    requireCanonicalUtc(campaign.updatedAt) !== transitionObservedAt
  ) {
    fail("TRANSITION_EVIDENCE_MISMATCH");
  }
  if (Date.parse(readyObservedAt) < Date.parse(transitionObservedAt)) {
    fail("STALE_READY_EVIDENCE");
  }

  if (!Array.isArray(transition.tasks)) fail("INVALID_INPUT");

  const taskIds = new Set<string>();
  const issueNumbers = new Set<number>();
  const pullRequestNumbers = new Set<number>();
  let selectedTask: TransitionTask | null = null;
  let mergedTaskMatches = 0;

  for (const task of transition.tasks) {
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
      fail("TRANSITION_EVIDENCE_MISMATCH");
    }
    if (taskIds.has(taskId) || issueNumbers.has(issueNumber)) {
      fail("TRANSITION_EVIDENCE_MISMATCH");
    }
    taskIds.add(taskId);
    issueNumbers.add(issueNumber);

    const hasPullRequest = task.activePullRequestNumber !== null;
    const hasExpectedHead = task.expectedHeadSha !== null;
    if (hasPullRequest !== hasExpectedHead) fail("TRANSITION_EVIDENCE_MISMATCH");
    if (task.expectedHeadSha !== null) requireSha(task.expectedHeadSha);
    if (task.activePullRequestNumber !== null) {
      const pullRequestNumber = requirePositiveInteger(task.activePullRequestNumber);
      if (pullRequestNumbers.has(pullRequestNumber)) fail("TRANSITION_EVIDENCE_MISMATCH");
      pullRequestNumbers.add(pullRequestNumber);
    }

    if (taskId === mergedTaskId) {
      mergedTaskMatches += 1;
      if (
        taskState !== "DONE" ||
        issueNumber !== mergedIssueNumber ||
        task.activePullRequestNumber !== null ||
        task.expectedHeadSha !== null ||
        updatedAt !== transitionObservedAt
      ) {
        fail("TRANSITION_EVIDENCE_MISMATCH");
      }
    }

    if (taskId === selectedTaskId) selectedTask = task;
  }

  if (mergedTaskMatches !== 1 || selectedTask === null) fail("READY_EVIDENCE_MISMATCH");
  if (
    selectedTask.issueNumber !== selectedIssueNumber ||
    selectedTask.projectId !== projectId ||
    selectedTask.repository !== campaign.repository ||
    !SELECTABLE_TASK_STATES.has(selectedTask.taskState) ||
    selectedTask.activePullRequestNumber !== null ||
    selectedTask.expectedHeadSha !== null
  ) {
    fail("READY_EVIDENCE_MISMATCH");
  }
  if (Date.parse(readyObservedAt) < Date.parse(selectedTask.updatedAt)) {
    fail("STALE_READY_EVIDENCE");
  }

  return {
    schemaVersion: 1,
    kind: "NEXT_TASK_TRANSITION",
    selectionEvidence: {
      taskId: selectedTaskId,
      issueNumber: selectedIssueNumber,
      expectedMainSha: readyMainSha,
      observedAt: readyObservedAt,
    },
    campaign: {
      schemaVersion: 1,
      campaignId,
      projectId,
      repository: campaign.repository,
      scope: campaign.scope,
      mode: campaign.mode,
      continueEnabled: campaign.continueEnabled,
      paused: campaign.paused,
      expectedMainSha: mergeSha,
      currentTask: { taskId: mergedTaskId, state: "DONE" },
      nextTaskId: selectedTaskId,
      humanGate: null,
      observedAt: readyObservedAt,
      updatedAt: readyObservedAt,
    },
    tasks: transition.tasks.map(cloneTask),
  };
}
