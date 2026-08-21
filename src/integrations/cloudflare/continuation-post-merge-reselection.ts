import {
  coordinateAuthoritativeContinuation,
  type ContinuationCoordinatorDependencies,
} from "../../shared/continuation-coordinator.js";
import type { ContinuationTaskBinding } from "../../shared/continuation-github-snapshot.js";
import {
  MAX_CONTINUATION_CANDIDATES,
  type ContinuationCampaignSnapshot,
  type ContinuationPlanResult,
  type ContinuationTaskState,
} from "../../shared/continuation-plan.js";
import type { ContinuationPostMergeTransitionProposal } from "./continuation-post-merge-transition.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TERMINAL_TASK_STATES = new Set<ContinuationTaskState>(["DONE", "CANCELLED"]);
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

export type ContinuationPostMergeReselectionErrorCode =
  | "INVALID_INPUT"
  | "TRANSITION_EVIDENCE_MISMATCH"
  | "TERMINAL_TASK_EVIDENCE_MISMATCH"
  | "STALE_POST_MERGE_OBSERVATION";

export class ContinuationPostMergeReselectionError extends Error {
  readonly code: ContinuationPostMergeReselectionErrorCode;

  constructor(code: ContinuationPostMergeReselectionErrorCode) {
    super("Post-merge continuation re-selection failed closed");
    this.name = "ContinuationPostMergeReselectionError";
    this.code = code;
  }
}

function fail(code: ContinuationPostMergeReselectionErrorCode): never {
  throw new ContinuationPostMergeReselectionError(code);
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
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
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

function validateTransitionAndBuildBindings(
  transition: ContinuationPostMergeTransitionProposal,
): {
  readonly campaign: ContinuationCampaignSnapshot;
  readonly bindings: readonly ContinuationTaskBinding[];
  readonly mergeSha: string;
  readonly transitionObservedAt: string;
} {
  if (!transition || typeof transition !== "object") fail("INVALID_INPUT");
  if (transition.schemaVersion !== 1 || transition.kind !== "POST_MERGE_TRANSITION") {
    fail("INVALID_INPUT");
  }

  const campaign = transition.campaign;
  const mergeEvidence = transition.mergeEvidence;
  if (!campaign || typeof campaign !== "object" || !mergeEvidence || typeof mergeEvidence !== "object") {
    fail("INVALID_INPUT");
  }
  if (campaign.schemaVersion !== 1 || mergeEvidence.merged !== true) fail("INVALID_INPUT");

  const campaignId = requireIdentifier(campaign.campaignId);
  const projectId = requireIdentifier(campaign.projectId);
  const mergedTaskId = requireIdentifier(mergeEvidence.taskId);
  const mergedIssueNumber = requirePositiveInteger(mergeEvidence.issueNumber);
  requirePositiveInteger(mergeEvidence.pullRequestNumber);
  requireSha(mergeEvidence.expectedHeadSha);
  const previousMainSha = requireSha(mergeEvidence.previousMainSha);
  const mergeSha = requireSha(mergeEvidence.mergeSha);
  const transitionObservedAt = requireCanonicalUtc(mergeEvidence.observedAt);

  if (typeof campaign.repository !== "string" || campaign.repository.length === 0) {
    fail("INVALID_INPUT");
  }
  if (typeof campaign.continueEnabled !== "boolean" || typeof campaign.paused !== "boolean") {
    fail("INVALID_INPUT");
  }
  if (campaign.mode !== "CONTINUE_ISSUES") fail("TRANSITION_EVIDENCE_MISMATCH");
  if (typeof campaign.scope !== "string" || campaign.scope.length === 0) fail("INVALID_INPUT");
  if (requireSha(campaign.expectedMainSha) !== mergeSha || previousMainSha === mergeSha) {
    fail("TRANSITION_EVIDENCE_MISMATCH");
  }
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

  if (!Array.isArray(transition.tasks) || transition.tasks.length > MAX_CONTINUATION_CANDIDATES) {
    fail("INVALID_INPUT");
  }

  const taskIds = new Set<string>();
  const issueNumbers = new Set<number>();
  const pullRequestNumbers = new Set<number>();
  const bindings: ContinuationTaskBinding[] = [];
  let mergedTaskMatches = 0;

  for (const task of transition.tasks) {
    if (!task || typeof task !== "object") fail("INVALID_INPUT");
    const taskId = requireIdentifier(task.taskId);
    const issueNumber = requirePositiveInteger(task.issueNumber);
    const taskState = requireTaskState(task.taskState);
    requireCanonicalUtc(task.updatedAt);

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

    if (TERMINAL_TASK_STATES.has(taskState)) {
      if (task.activePullRequestNumber !== null || task.expectedHeadSha !== null) {
        fail("TERMINAL_TASK_EVIDENCE_MISMATCH");
      }
      if (taskId === mergedTaskId) {
        mergedTaskMatches += 1;
        if (
          taskState !== "DONE" ||
          issueNumber !== mergedIssueNumber ||
          task.updatedAt !== transitionObservedAt
        ) {
          fail("TRANSITION_EVIDENCE_MISMATCH");
        }
      }
      continue;
    }

    if (taskId === mergedTaskId) fail("TRANSITION_EVIDENCE_MISMATCH");
    bindings.push({
      taskId,
      projectId,
      repository: campaign.repository,
      issueNumber,
      taskState,
      activePullRequestNumber: task.activePullRequestNumber,
      expectedHeadSha: task.expectedHeadSha,
      priority: task.priority,
    });
  }

  if (mergedTaskMatches !== 1) fail("TRANSITION_EVIDENCE_MISMATCH");

  return {
    campaign: {
      schemaVersion: 1,
      campaignId,
      projectId,
      repository: campaign.repository,
      continueEnabled: campaign.continueEnabled,
      paused: campaign.paused,
      currentTask: { taskId: mergedTaskId, state: "DONE" },
      humanGate: null,
    },
    bindings,
    mergeSha,
    transitionObservedAt,
  };
}

/**
 * Re-read GitHub from the verified post-merge main and select at most one next task.
 *
 * Terminal tasks are intentionally excluded from open-issue observation. READY is
 * inert planning evidence only: this boundary never persists or starts a task and
 * never grants merge, deploy, notification, scheduling or other mutation authority.
 */
export async function reselectContinuationAfterMerge(
  transition: ContinuationPostMergeTransitionProposal,
  dependencies: ContinuationCoordinatorDependencies,
): Promise<ContinuationPlanResult> {
  const validated = validateTransitionAndBuildBindings(transition);
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    !dependencies.provider ||
    typeof dependencies.provider !== "object" ||
    typeof dependencies.now !== "function"
  ) {
    fail("INVALID_INPUT");
  }

  const transitionTime = Date.parse(validated.transitionObservedAt);
  const guardedNow = (): string => {
    const observedAt = requireCanonicalUtc(dependencies.now());
    if (Date.parse(observedAt) < transitionTime) fail("STALE_POST_MERGE_OBSERVATION");
    return observedAt;
  };

  return coordinateAuthoritativeContinuation(
    validated.campaign,
    validated.bindings,
    validated.mergeSha,
    { provider: dependencies.provider, now: guardedNow },
  );
}
