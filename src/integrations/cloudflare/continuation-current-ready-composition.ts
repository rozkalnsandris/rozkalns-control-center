import type { ContinuationPlanResult } from "../../shared/continuation-plan.js";
import {
  planContinuationCurrentReadyTransition,
  type ContinuationCurrentReadyTransitionProposal,
} from "./continuation-current-ready-transition.js";
import type { ContinuationCurrentReadyPersistenceResult } from "./continuation-current-ready-persistence.js";
import {
  planContinuationNextTaskTransition,
  type ContinuationNextTaskTransitionProposal,
} from "./continuation-next-task-transition.js";
import type { ContinuationPostMergeTransitionProposal } from "./continuation-post-merge-transition.js";
import type {
  ContinuationCampaignRecoveryEvidence,
  ContinuationCampaignRecoveryIdentity,
  DurableContinuationCampaignSnapshot,
  DurableContinuationTaskSnapshot,
} from "./d1-continuation-campaign-reader.js";
import type { ContinuationNextTaskPersistenceResult } from "./d1-continuation-next-task-store.js";

type NonReadyContinuationPlan = Exclude<ContinuationPlanResult, { readonly kind: "READY" }>;
type ReadyContinuationPlan = Extract<ContinuationPlanResult, { readonly kind: "READY" }>;

export type ContinuationCurrentReadyReservationEvidence =
  | ContinuationNextTaskPersistenceResult
  | { readonly kind: "ALREADY_CURRENT_READY" };

export type ContinuationCurrentReadyCompositionResult =
  | { readonly kind: "NO_CURRENT_READY"; readonly plan: NonReadyContinuationPlan }
  | {
      readonly kind: "CURRENT_READY";
      readonly plan: ReadyContinuationPlan;
      readonly reservation: ContinuationCurrentReadyReservationEvidence;
      readonly currentReady: ContinuationCurrentReadyPersistenceResult;
    };

export interface ContinuationCurrentReadyCompositionDependencies {
  reselect(
    transition: ContinuationPostMergeTransitionProposal,
  ): Promise<ContinuationPlanResult>;
  reserve(
    expected: ContinuationPostMergeTransitionProposal,
    transition: ContinuationNextTaskTransitionProposal,
  ): Promise<ContinuationNextTaskPersistenceResult>;
  read(
    identity: ContinuationCampaignRecoveryIdentity,
  ): Promise<ContinuationCampaignRecoveryEvidence>;
  persistCurrentReady(
    recovery: ContinuationCampaignRecoveryEvidence,
    plan: ReadyContinuationPlan,
  ): Promise<ContinuationCurrentReadyPersistenceResult>;
}

export type ContinuationCurrentReadyCompositionErrorCode =
  | "INVALID_INPUT"
  | "DURABLE_RECOVERY_FAILED"
  | "POST_RESERVATION_RECOVERY_MISMATCH";

export class ContinuationCurrentReadyCompositionError extends Error {
  readonly code: ContinuationCurrentReadyCompositionErrorCode;

  constructor(code: ContinuationCurrentReadyCompositionErrorCode) {
    super("Continuation current READY composition failed closed");
    this.name = "ContinuationCurrentReadyCompositionError";
    this.code = code;
  }
}

interface DurableStateTarget {
  readonly campaign: DurableContinuationCampaignSnapshot;
  readonly tasks: readonly DurableContinuationTaskSnapshot[];
}

function fail(code: ContinuationCurrentReadyCompositionErrorCode): never {
  throw new ContinuationCurrentReadyCompositionError(code);
}

function sameCampaign(
  left: DurableContinuationCampaignSnapshot,
  right: DurableContinuationCampaignSnapshot,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.campaignId === right.campaignId &&
    left.projectId === right.projectId &&
    left.repository === right.repository &&
    left.scope === right.scope &&
    left.mode === right.mode &&
    left.continueEnabled === right.continueEnabled &&
    left.paused === right.paused &&
    left.expectedMainSha === right.expectedMainSha &&
    left.currentTask?.taskId === right.currentTask?.taskId &&
    left.currentTask?.state === right.currentTask?.state &&
    left.nextTaskId === right.nextTaskId &&
    left.humanGate === right.humanGate &&
    left.observedAt === right.observedAt &&
    left.updatedAt === right.updatedAt
  );
}

function sameTask(
  left: DurableContinuationTaskSnapshot,
  right: DurableContinuationTaskSnapshot,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.projectId === right.projectId &&
    left.repository === right.repository &&
    left.issueNumber === right.issueNumber &&
    left.taskState === right.taskState &&
    left.activePullRequestNumber === right.activePullRequestNumber &&
    left.expectedHeadSha === right.expectedHeadSha &&
    left.priority === right.priority &&
    left.updatedAt === right.updatedAt
  );
}

function sameTaskSet(
  left: readonly DurableContinuationTaskSnapshot[],
  right: readonly DurableContinuationTaskSnapshot[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByTask = new Map(right.map((task) => [task.taskId, task]));
  if (rightByTask.size !== right.length) return false;
  return left.every((task) => {
    const match = rightByTask.get(task.taskId);
    return match !== undefined && sameTask(task, match);
  });
}

function recoveryMatches(
  recovery: ContinuationCampaignRecoveryEvidence,
  target: DurableStateTarget,
): boolean {
  return (
    recovery.kind === "FOUND" &&
    sameCampaign(recovery.campaign, target.campaign) &&
    sameTaskSet(recovery.tasks, target.tasks)
  );
}

function validateDependencies(dependencies: ContinuationCurrentReadyCompositionDependencies): void {
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    typeof dependencies.reselect !== "function" ||
    typeof dependencies.reserve !== "function" ||
    typeof dependencies.read !== "function" ||
    typeof dependencies.persistCurrentReady !== "function"
  ) {
    fail("INVALID_INPUT");
  }
}

async function readDurable(
  dependencies: ContinuationCurrentReadyCompositionDependencies,
  identity: ContinuationCampaignRecoveryIdentity,
): Promise<ContinuationCampaignRecoveryEvidence> {
  try {
    return await dependencies.read(identity);
  } catch {
    fail("DURABLE_RECOVERY_FAILED");
  }
}

/**
 * Compose the reviewed post-merge re-selection, next-task reservation and
 * current-READY persistence boundaries without starting or scheduling work.
 *
 * READY remains inert deterministic state evidence. The composition performs
 * no I/O until explicitly invoked and grants no merge, deploy or execution
 * authority.
 */
export async function composeContinuationCurrentReady(
  transition: ContinuationPostMergeTransitionProposal,
  dependencies: ContinuationCurrentReadyCompositionDependencies,
): Promise<ContinuationCurrentReadyCompositionResult> {
  if (!transition || typeof transition !== "object") fail("INVALID_INPUT");
  validateDependencies(dependencies);

  const plan = await dependencies.reselect(transition);
  if (plan.kind !== "READY") return { kind: "NO_CURRENT_READY", plan };

  const nextTaskTransition = planContinuationNextTaskTransition(transition, plan);
  const reservedRecovery: ContinuationCampaignRecoveryEvidence = {
    kind: "FOUND",
    campaign: nextTaskTransition.campaign,
    tasks: nextTaskTransition.tasks,
  };
  const currentReadyTransition: ContinuationCurrentReadyTransitionProposal =
    planContinuationCurrentReadyTransition(reservedRecovery, plan);
  const identity: ContinuationCampaignRecoveryIdentity = {
    campaignId: plan.campaignId,
    projectId: plan.projectId,
    repository: plan.repository,
    expectedMainSha: plan.expectedMainSha,
  };

  const beforeReservation = await readDurable(dependencies, identity);
  if (recoveryMatches(beforeReservation, currentReadyTransition)) {
    return {
      kind: "CURRENT_READY",
      plan,
      reservation: { kind: "ALREADY_CURRENT_READY" },
      currentReady: { kind: "ALREADY_APPLIED" },
    };
  }

  const reservation = await dependencies.reserve(transition, nextTaskTransition);
  const afterReservation = await readDurable(dependencies, identity);

  if (recoveryMatches(afterReservation, currentReadyTransition)) {
    return {
      kind: "CURRENT_READY",
      plan,
      reservation,
      currentReady: { kind: "ALREADY_APPLIED" },
    };
  }
  if (!recoveryMatches(afterReservation, reservedRecovery)) {
    fail("POST_RESERVATION_RECOVERY_MISMATCH");
  }

  const currentReady = await dependencies.persistCurrentReady(afterReservation, plan);
  return { kind: "CURRENT_READY", plan, reservation, currentReady };
}
