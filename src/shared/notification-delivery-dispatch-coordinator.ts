import type { NotificationDeliveryAttemptStore } from "./notification-delivery-attempt-store.js";
import {
  notificationDeliveryDispatchAttempt,
  type NotificationDeliveryDispatchAdapter,
  type NotificationDeliveryDispatchAttempt,
} from "./notification-delivery-dispatch-attempt.js";
import type {
  NotificationDeliveryDispatchClaimRecoveryReader,
  NotificationDeliveryDispatchClaimStore,
} from "./notification-delivery-dispatch-claim-store.js";
import type { NotificationDeliveryDispatchDecision } from "./notification-delivery-dispatch-decision.js";
import {
  executeNotificationDeliveryDispatch,
  type NotificationDeliveryDispatchExecutionResult,
} from "./notification-delivery-dispatch-execution.js";
import {
  recoverNotificationDeliveryDispatch,
  type NotificationDeliveryDispatchRecoveryResult,
} from "./notification-delivery-dispatch-recovery.js";
import type {
  NotificationDeliveryEnvelope,
  NotificationDeliveryResult,
} from "./notification-delivery.js";

export interface NotificationDeliveryDispatchCoordinatorDependencies {
  readonly attemptStore: NotificationDeliveryAttemptStore;
  readonly claimReader: NotificationDeliveryDispatchClaimRecoveryReader;
  readonly claimStore: NotificationDeliveryDispatchClaimStore;
  readonly adapter: NotificationDeliveryDispatchAdapter;
}

export type NotificationDeliveryDispatchCoordinatorResult =
  | {
      readonly kind: "RECORDED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
      readonly attemptedAt: string;
      readonly result: NotificationDeliveryResult;
      readonly evidence: "RECOVERY" | "EXECUTION";
    }
  | {
      /** Durable claim without an exact result: replay barrier, never resend permission. */
      readonly kind: "AMBIGUOUS_CLAIMED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
      readonly attemptedAt: string;
    };

export type NotificationDeliveryDispatchCoordinatorErrorCode =
  | "INVALID_INPUT"
  | "POST_EXECUTION_EVIDENCE_INCONSISTENT"
  | "UNSUPPORTED_EXECUTION_RESULT";

export class NotificationDeliveryDispatchCoordinatorError extends Error {
  readonly code: NotificationDeliveryDispatchCoordinatorErrorCode;

  constructor(code: NotificationDeliveryDispatchCoordinatorErrorCode) {
    super("Notification delivery dispatch coordination failed closed");
    this.name = "NotificationDeliveryDispatchCoordinatorError";
    this.code = code;
  }
}

function validationProbe(
  envelope: NotificationDeliveryEnvelope,
  decision: NotificationDeliveryDispatchDecision,
): NotificationDeliveryDispatchAttempt {
  if (!decision || typeof decision !== "object" || decision.kind !== "READY") {
    throw new NotificationDeliveryDispatchCoordinatorError("INVALID_INPUT");
  }

  try {
    // Pure validation only: using eligibleAt as attemptedAt proves the envelope,
    // exact READY decision, attempt bounds and UTC eligibility evidence without
    // touching durable state or the provider boundary.
    return notificationDeliveryDispatchAttempt(envelope, decision, decision.eligibleAt);
  } catch {
    throw new NotificationDeliveryDispatchCoordinatorError("INVALID_INPUT");
  }
}

function recoveredResult(
  recovery: NotificationDeliveryDispatchRecoveryResult,
): NotificationDeliveryDispatchCoordinatorResult | undefined {
  if (recovery.kind === "RECORDED") {
    return {
      kind: "RECORDED",
      dispatchId: recovery.dispatchId,
      attemptNumber: recovery.attemptNumber,
      attemptedAt: recovery.attemptedAt,
      result: recovery.result,
      evidence: "RECOVERY",
    };
  }

  if (recovery.kind === "AMBIGUOUS_CLAIMED") {
    return {
      kind: "AMBIGUOUS_CLAIMED",
      dispatchId: recovery.dispatchId,
      attemptNumber: recovery.attemptNumber,
      attemptedAt: recovery.attemptedAt,
    };
  }

  return undefined;
}

async function recoverAfterExecutionBoundary(
  envelope: NotificationDeliveryEnvelope,
  attemptNumber: number,
  dependencies: NotificationDeliveryDispatchCoordinatorDependencies,
): Promise<NotificationDeliveryDispatchCoordinatorResult | undefined> {
  const recovery = await recoverNotificationDeliveryDispatch(envelope, attemptNumber, {
    attemptStore: dependencies.attemptStore,
    claimReader: dependencies.claimReader,
  });
  return recoveredResult(recovery);
}

/**
 * Reconcile durable replay evidence before executing at most one exact dispatch.
 *
 * Initial durable evidence always wins. Only `NOT_STARTED` may cross into the
 * single-attempt execution contract. Any claim race or ambiguous execution is
 * followed by at most one restart-safe read-only recovery and is never converted
 * into permission for a second execution or resend.
 */
export async function coordinateNotificationDeliveryDispatch(
  envelopeInput: NotificationDeliveryEnvelope,
  decisionInput: NotificationDeliveryDispatchDecision,
  attemptedAtInput: string,
  dependencies: NotificationDeliveryDispatchCoordinatorDependencies,
): Promise<NotificationDeliveryDispatchCoordinatorResult> {
  const probe = validationProbe(envelopeInput, decisionInput);

  const initialRecovery = await recoverNotificationDeliveryDispatch(
    probe.envelope,
    probe.attemptNumber,
    {
      attemptStore: dependencies.attemptStore,
      claimReader: dependencies.claimReader,
    },
  );
  const initial = recoveredResult(initialRecovery);
  if (initial) return initial;

  let attempt: NotificationDeliveryDispatchAttempt;
  try {
    attempt = notificationDeliveryDispatchAttempt(
      probe.envelope,
      decisionInput,
      attemptedAtInput,
    );
  } catch {
    throw new NotificationDeliveryDispatchCoordinatorError("INVALID_INPUT");
  }

  let execution: NotificationDeliveryDispatchExecutionResult;
  try {
    execution = await executeNotificationDeliveryDispatch(attempt, {
      attemptStore: dependencies.attemptStore,
      claimStore: dependencies.claimStore,
      adapter: dependencies.adapter,
    });
  } catch (error) {
    try {
      const recovered = await recoverAfterExecutionBoundary(
        attempt.envelope,
        attempt.attemptNumber,
        dependencies,
      );
      if (recovered) return recovered;
    } catch {
      // Preserve the original fail-closed execution error if durable recovery
      // itself cannot be proven. Never retry execution from this path.
    }
    throw error;
  }

  if (execution.kind === "RECORDED") {
    return {
      kind: "RECORDED",
      dispatchId: execution.dispatchId,
      attemptNumber: execution.attemptNumber,
      attemptedAt: attempt.attemptedAt,
      result: execution.result,
      evidence: "EXECUTION",
    };
  }

  if (execution.kind === "ALREADY_CLAIMED") {
    const recovered = await recoverAfterExecutionBoundary(
      attempt.envelope,
      attempt.attemptNumber,
      dependencies,
    );
    if (recovered) return recovered;
    throw new NotificationDeliveryDispatchCoordinatorError(
      "POST_EXECUTION_EVIDENCE_INCONSISTENT",
    );
  }

  throw new NotificationDeliveryDispatchCoordinatorError("UNSUPPORTED_EXECUTION_RESULT");
}
