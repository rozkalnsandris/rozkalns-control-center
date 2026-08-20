import {
  appendNotificationDeliveryAttempt,
  notificationDeliveryAttemptCanRetry,
  type NotificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptRecord,
} from "./notification-delivery-attempt.js";
import type { NotificationDeliveryAttemptStore } from "./notification-delivery-attempt-store.js";
import {
  notificationDeliveryDispatchAttempt,
  type NotificationDeliveryDispatchAttempt,
} from "./notification-delivery-dispatch-attempt.js";
import type {
  NotificationDeliveryDispatchClaimEvidence,
  NotificationDeliveryDispatchClaimReader,
} from "./notification-delivery-dispatch-claim-store.js";
import type { NotificationDeliveryResult } from "./notification-delivery.js";

export interface NotificationDeliveryDispatchReconciliationDependencies {
  readonly attemptStore: NotificationDeliveryAttemptStore;
  readonly claimReader: NotificationDeliveryDispatchClaimReader;
}

export type NotificationDeliveryDispatchReconciliationResult =
  | {
      readonly kind: "NOT_STARTED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
    }
  | {
      readonly kind: "AMBIGUOUS_CLAIMED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
    }
  | {
      readonly kind: "RECORDED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
      readonly result: NotificationDeliveryResult;
    };

export type NotificationDeliveryDispatchReconciliationErrorCode =
  | "INVALID_ATTEMPT"
  | "ATTEMPT_EVIDENCE_UNCONFIRMED"
  | "ATTEMPT_STATE_MISMATCH"
  | "CLAIM_EVIDENCE_UNCONFIRMED"
  | "RESULT_EVIDENCE_MISMATCH"
  | "UNCLAIMED_RESULT";

export class NotificationDeliveryDispatchReconciliationError extends Error {
  readonly code: NotificationDeliveryDispatchReconciliationErrorCode;

  constructor(code: NotificationDeliveryDispatchReconciliationErrorCode) {
    super("Notification delivery dispatch reconciliation failed closed");
    this.name = "NotificationDeliveryDispatchReconciliationError";
    this.code = code;
  }
}

function normalizeAttempt(
  attempt: NotificationDeliveryDispatchAttempt,
): NotificationDeliveryDispatchAttempt {
  try {
    const expected = notificationDeliveryDispatchAttempt(
      attempt.envelope,
      {
        kind: "READY",
        attemptNumber: attempt.attemptNumber,
        eligibleAt: attempt.attemptedAt,
      },
      attempt.attemptedAt,
    );

    if (
      attempt.schemaVersion !== expected.schemaVersion ||
      attempt.dispatchId !== expected.dispatchId ||
      attempt.deliveryId !== expected.deliveryId ||
      attempt.attemptNumber !== expected.attemptNumber ||
      attempt.attemptedAt !== expected.attemptedAt
    ) {
      throw new Error("dispatch attempt identity mismatch");
    }

    return expected;
  } catch {
    throw new NotificationDeliveryDispatchReconciliationError("INVALID_ATTEMPT");
  }
}

function validateHistory(
  history: NotificationDeliveryAttemptHistory,
  attempt: NotificationDeliveryDispatchAttempt,
): NotificationDeliveryAttemptRecord | undefined {
  try {
    // The lifecycle validator checks the complete history, exact sequence,
    // finality and typed provider results. The boolean itself is not used here.
    notificationDeliveryAttemptCanRetry(history);
  } catch {
    throw new NotificationDeliveryDispatchReconciliationError(
      "ATTEMPT_STATE_MISMATCH",
    );
  }

  if (history.deliveryId !== attempt.deliveryId) {
    throw new NotificationDeliveryDispatchReconciliationError(
      "ATTEMPT_STATE_MISMATCH",
    );
  }

  const recorded = history.attempts[attempt.attemptNumber - 1];
  if (recorded) {
    if (
      recorded.deliveryId !== attempt.deliveryId ||
      recorded.attemptNumber !== attempt.attemptNumber ||
      recorded.attemptedAt !== attempt.attemptedAt
    ) {
      throw new NotificationDeliveryDispatchReconciliationError(
        "RESULT_EVIDENCE_MISMATCH",
      );
    }
    return recorded;
  }

  const previous = history.attempts[history.attempts.length - 1];
  if (previous && Date.parse(attempt.attemptedAt) < Date.parse(previous.attemptedAt)) {
    throw new NotificationDeliveryDispatchReconciliationError(
      "ATTEMPT_STATE_MISMATCH",
    );
  }

  try {
    // In-memory probe only. If this exact attempt is not the next legal slot,
    // append validation fails closed. Nothing is persisted by this operation.
    appendNotificationDeliveryAttempt(history, {
      schemaVersion: 1,
      deliveryId: attempt.deliveryId,
      attemptNumber: attempt.attemptNumber,
      attemptedAt: attempt.attemptedAt,
      result: { kind: "DELIVERED" },
    });
  } catch {
    throw new NotificationDeliveryDispatchReconciliationError(
      "ATTEMPT_STATE_MISMATCH",
    );
  }

  return undefined;
}

function requireClaimEvidence(
  evidence: NotificationDeliveryDispatchClaimEvidence,
): NotificationDeliveryDispatchClaimEvidence {
  if (evidence?.kind !== "NOT_CLAIMED" && evidence?.kind !== "CLAIMED") {
    throw new NotificationDeliveryDispatchReconciliationError(
      "CLAIM_EVIDENCE_UNCONFIRMED",
    );
  }
  return evidence;
}

/**
 * Reconcile one exact dispatch attempt from durable evidence only.
 *
 * `AMBIGUOUS_CLAIMED` is deliberately not retry permission. A prior execution
 * may already have crossed the provider boundary, so the durable claim remains
 * the replay barrier until exact result evidence exists.
 */
export async function reconcileNotificationDeliveryDispatch(
  attemptInput: NotificationDeliveryDispatchAttempt,
  dependencies: NotificationDeliveryDispatchReconciliationDependencies,
): Promise<NotificationDeliveryDispatchReconciliationResult> {
  const attempt = normalizeAttempt(attemptInput);

  let history: NotificationDeliveryAttemptHistory;
  try {
    history = await dependencies.attemptStore.readHistory(attempt.deliveryId);
  } catch {
    throw new NotificationDeliveryDispatchReconciliationError(
      "ATTEMPT_EVIDENCE_UNCONFIRMED",
    );
  }

  const recorded = validateHistory(history, attempt);

  let claimEvidence: NotificationDeliveryDispatchClaimEvidence;
  try {
    claimEvidence = requireClaimEvidence(await dependencies.claimReader.read(attempt));
  } catch (error) {
    if (error instanceof NotificationDeliveryDispatchReconciliationError) throw error;
    throw new NotificationDeliveryDispatchReconciliationError(
      "CLAIM_EVIDENCE_UNCONFIRMED",
    );
  }

  if (recorded) {
    if (claimEvidence.kind !== "CLAIMED") {
      throw new NotificationDeliveryDispatchReconciliationError("UNCLAIMED_RESULT");
    }

    return {
      kind: "RECORDED",
      dispatchId: attempt.dispatchId,
      attemptNumber: attempt.attemptNumber,
      result: recorded.result,
    };
  }

  if (claimEvidence.kind === "CLAIMED") {
    return {
      kind: "AMBIGUOUS_CLAIMED",
      dispatchId: attempt.dispatchId,
      attemptNumber: attempt.attemptNumber,
    };
  }

  return {
    kind: "NOT_STARTED",
    dispatchId: attempt.dispatchId,
    attemptNumber: attempt.attemptNumber,
  };
}
