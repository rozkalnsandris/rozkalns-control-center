import type {
  ContinuationCampaignRecoveryEvidence,
  DurableContinuationCampaignSnapshot,
  DurableContinuationTaskSnapshot,
} from "./d1-continuation-campaign-reader.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface ContinuationSuccessfulMergeReceipt {
  readonly schemaVersion: 1;
  readonly merged: boolean;
  readonly campaignId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly taskId: string;
  readonly issueNumber: number;
  readonly pullRequestNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly mergeSha: string;
  readonly observedMainSha: string;
  readonly observedAt: string;
}

export interface ContinuationPostMergeTransitionProposal {
  readonly schemaVersion: 1;
  readonly kind: "POST_MERGE_TRANSITION";
  readonly mergeEvidence: {
    readonly merged: true;
    readonly taskId: string;
    readonly issueNumber: number;
    readonly pullRequestNumber: number;
    readonly expectedHeadSha: string;
    readonly previousMainSha: string;
    readonly mergeSha: string;
    readonly observedAt: string;
  };
  readonly campaign: DurableContinuationCampaignSnapshot;
  readonly tasks: readonly DurableContinuationTaskSnapshot[];
}

export type ContinuationPostMergeTransitionErrorCode =
  | "INVALID_INPUT"
  | "RECOVERY_NOT_FOUND"
  | "RECOVERY_EVIDENCE_MISMATCH"
  | "MERGE_NOT_SUCCESSFUL"
  | "MERGE_GATE_MISMATCH"
  | "CURRENT_TASK_MISMATCH"
  | "MERGE_RECEIPT_MISMATCH"
  | "MERGE_RECEIPT_REPLAY"
  | "POST_MERGE_MAIN_DRIFT"
  | "STALE_MERGE_EVIDENCE";

export class ContinuationPostMergeTransitionError extends Error {
  readonly code: ContinuationPostMergeTransitionErrorCode;

  constructor(code: ContinuationPostMergeTransitionErrorCode) {
    super("Post-merge continuation transition failed closed");
    this.name = "ContinuationPostMergeTransitionError";
    this.code = code;
  }
}

function fail(code: ContinuationPostMergeTransitionErrorCode): never {
  throw new ContinuationPostMergeTransitionError(code);
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
 * Build inert persistence evidence after one already-successful authorized merge.
 *
 * This function performs no I/O and grants no merge, deploy, D1 write,
 * notification, scheduling or continuation authorization. It deliberately
 * clears nextTaskId so a later authoritative GitHub observation must select the
 * next eligible unit from the new exact main SHA.
 */
export function planContinuationPostMergeTransition(
  recovery: ContinuationCampaignRecoveryEvidence,
  receipt: ContinuationSuccessfulMergeReceipt,
): ContinuationPostMergeTransitionProposal {
  if (!recovery || typeof recovery !== "object" || !receipt || typeof receipt !== "object") {
    fail("INVALID_INPUT");
  }
  if (recovery.kind === "NOT_FOUND") fail("RECOVERY_NOT_FOUND");
  if (recovery.kind !== "FOUND") fail("INVALID_INPUT");
  if (receipt.schemaVersion !== 1) fail("INVALID_INPUT");

  const campaignId = requireIdentifier(receipt.campaignId);
  const projectId = requireIdentifier(receipt.projectId);
  const taskId = requireIdentifier(receipt.taskId);
  if (typeof receipt.repository !== "string" || receipt.repository.length === 0) {
    fail("INVALID_INPUT");
  }
  const issueNumber = requirePositiveInteger(receipt.issueNumber);
  const pullRequestNumber = requirePositiveInteger(receipt.pullRequestNumber);
  const expectedHeadSha = requireSha(receipt.expectedHeadSha);
  const expectedMainSha = requireSha(receipt.expectedMainSha);
  const mergeSha = requireSha(receipt.mergeSha);
  const observedMainSha = requireSha(receipt.observedMainSha);
  const observedAt = requireCanonicalUtc(receipt.observedAt);

  if (receipt.merged !== true) fail("MERGE_NOT_SUCCESSFUL");

  const campaign = recovery.campaign;
  if (
    campaign.campaignId !== campaignId ||
    campaign.projectId !== projectId ||
    campaign.repository !== receipt.repository ||
    campaign.expectedMainSha !== expectedMainSha
  ) {
    fail("RECOVERY_EVIDENCE_MISMATCH");
  }
  if (campaign.humanGate !== "MERGE") fail("MERGE_GATE_MISMATCH");
  if (
    campaign.currentTask === null ||
    campaign.currentTask.taskId !== taskId ||
    campaign.currentTask.state !== "MERGE_READY"
  ) {
    fail("CURRENT_TASK_MISMATCH");
  }
  if (campaign.nextTaskId !== null) fail("RECOVERY_EVIDENCE_MISMATCH");

  const currentTask = recovery.tasks.find((task) => task.taskId === taskId);
  if (
    !currentTask ||
    currentTask.projectId !== projectId ||
    currentTask.repository !== receipt.repository ||
    currentTask.issueNumber !== issueNumber ||
    currentTask.taskState !== "MERGE_READY" ||
    currentTask.activePullRequestNumber !== pullRequestNumber ||
    currentTask.expectedHeadSha !== expectedHeadSha
  ) {
    fail("MERGE_RECEIPT_MISMATCH");
  }

  if (mergeSha === expectedMainSha) fail("MERGE_RECEIPT_REPLAY");
  if (observedMainSha !== mergeSha) fail("POST_MERGE_MAIN_DRIFT");
  if (
    Date.parse(observedAt) < Date.parse(campaign.updatedAt) ||
    Date.parse(observedAt) < Date.parse(currentTask.updatedAt)
  ) {
    fail("STALE_MERGE_EVIDENCE");
  }

  const tasks = recovery.tasks.map((task) => {
    if (task.taskId !== taskId) return cloneTask(task);
    return {
      taskId: task.taskId,
      projectId: task.projectId,
      repository: task.repository,
      issueNumber: task.issueNumber,
      taskState: "DONE" as const,
      activePullRequestNumber: null,
      expectedHeadSha: null,
      priority: task.priority,
      updatedAt: observedAt,
    };
  });

  return {
    schemaVersion: 1,
    kind: "POST_MERGE_TRANSITION",
    mergeEvidence: {
      merged: true,
      taskId,
      issueNumber,
      pullRequestNumber,
      expectedHeadSha,
      previousMainSha: expectedMainSha,
      mergeSha,
      observedAt,
    },
    campaign: {
      schemaVersion: 1,
      campaignId: campaign.campaignId,
      projectId: campaign.projectId,
      repository: campaign.repository,
      scope: campaign.scope,
      mode: campaign.mode,
      continueEnabled: campaign.continueEnabled,
      paused: campaign.paused,
      expectedMainSha: mergeSha,
      currentTask: { taskId, state: "DONE" },
      nextTaskId: null,
      humanGate: null,
      observedAt,
      updatedAt: observedAt,
    },
    tasks,
  };
}
