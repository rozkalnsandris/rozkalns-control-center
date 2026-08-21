import {
  coordinateAuthoritativeContinuation,
  type ContinuationCoordinatorDependencies,
} from "../../shared/continuation-coordinator.js";
import type { ContinuationTaskBinding } from "../../shared/continuation-github-snapshot.js";
import type { ContinuationPlanResult } from "../../shared/continuation-plan.js";
import type {
  ContinuationCampaignRecoveryEvidence,
  ContinuationCampaignRecoveryIdentity,
} from "./d1-continuation-campaign-reader.js";

export interface ContinuationCampaignRecoveryReader {
  read(
    input: ContinuationCampaignRecoveryIdentity,
  ): Promise<ContinuationCampaignRecoveryEvidence>;
}

export type ContinuationRecoveryCoordinationResult =
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "COORDINATED"; readonly plan: ContinuationPlanResult };

export type ContinuationRecoveryCoordinatorErrorCode =
  | "INVALID_INPUT"
  | "RECOVERY_EVIDENCE_MISMATCH"
  | "NEXT_TASK_EVIDENCE_DRIFT";

export class ContinuationRecoveryCoordinatorError extends Error {
  readonly code: ContinuationRecoveryCoordinatorErrorCode;

  constructor(code: ContinuationRecoveryCoordinatorErrorCode) {
    super("Durable continuation recovery coordination failed closed");
    this.name = "ContinuationRecoveryCoordinatorError";
    this.code = code;
  }
}

function fail(code: ContinuationRecoveryCoordinatorErrorCode): never {
  throw new ContinuationRecoveryCoordinatorError(code);
}

function sealBindings(
  evidence: Extract<ContinuationCampaignRecoveryEvidence, { kind: "FOUND" }>,
): ContinuationTaskBinding[] {
  return evidence.tasks.map((task) => ({
    taskId: task.taskId,
    projectId: task.projectId,
    repository: task.repository,
    issueNumber: task.issueNumber,
    taskState: task.taskState,
    activePullRequestNumber: task.activePullRequestNumber,
    expectedHeadSha: task.expectedHeadSha,
    priority: task.priority,
  }));
}

/**
 * Recover one durable continuation campaign and re-resolve its task choice
 * against authoritative GitHub reads without activating runtime behavior.
 *
 * A durable nextTaskId, when present, is an exact pin: fresh GitHub evidence
 * may confirm it or fail closed, but may never silently substitute a different
 * task. COORDINATED/READY remains planning evidence only and grants no merge,
 * deploy, send, scheduling, persistence or other mutation permission.
 */
export async function recoverAndCoordinateAuthoritativeContinuation(
  reader: ContinuationCampaignRecoveryReader,
  identity: ContinuationCampaignRecoveryIdentity,
  dependencies: ContinuationCoordinatorDependencies,
): Promise<ContinuationRecoveryCoordinationResult> {
  if (!reader || typeof reader !== "object" || typeof reader.read !== "function") {
    fail("INVALID_INPUT");
  }

  const recovery = await reader.read(identity);
  if (recovery.kind === "NOT_FOUND") return { kind: "NOT_FOUND" };

  if (
    recovery.campaign.campaignId !== identity.campaignId ||
    recovery.campaign.projectId !== identity.projectId ||
    recovery.campaign.repository !== identity.repository ||
    recovery.campaign.expectedMainSha !== identity.expectedMainSha
  ) {
    fail("RECOVERY_EVIDENCE_MISMATCH");
  }

  const plan = await coordinateAuthoritativeContinuation(
    recovery.campaign,
    sealBindings(recovery),
    recovery.campaign.expectedMainSha,
    dependencies,
  );

  if (
    recovery.campaign.nextTaskId !== null &&
    (plan.kind !== "READY" || plan.taskId !== recovery.campaign.nextTaskId)
  ) {
    fail("NEXT_TASK_EVIDENCE_DRIFT");
  }

  return { kind: "COORDINATED", plan };
}
