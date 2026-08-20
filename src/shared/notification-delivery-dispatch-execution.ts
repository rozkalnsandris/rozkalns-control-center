import {
  appendNotificationDeliveryAttempt,
  type NotificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptRecord,
} from "./notification-delivery-attempt.js";
import type { NotificationDeliveryAttemptStore } from "./notification-delivery-attempt-store.js";
import type {
  NotificationDeliveryDispatchAdapter,
  NotificationDeliveryDispatchAttempt,
} from "./notification-delivery-dispatch-attempt.js";
import type { NotificationDeliveryDispatchClaimStore } from "./notification-delivery-dispatch-claim-store.js";
import type { NotificationDeliveryResult } from "./notification-delivery.js";

export interface NotificationDeliveryDispatchExecutionDependencies {
  readonly claimStore: NotificationDeliveryDispatchClaimStore;
  readonly attemptStore: NotificationDeliveryAttemptStore;
  readonly adapter: NotificationDeliveryDispatchAdapter;
}

export type NotificationDeliveryDispatchExecutionResult =
  | {
      readonly kind: "RECORDED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
      readonly result: NotificationDeliveryResult;
      readonly persistence: "APPENDED" | "DUPLICATE";
    }
  | {
      readonly kind: "ALREADY_CLAIMED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
    };

export type NotificationDeliveryDispatchExecutionErrorCode =
  | "ATTEMPT_STATE_MISMATCH"
  | "CLAIM_UNCONFIRMED"
  | "PROVIDER_OUTCOME_AMBIGUOUS"
  | "INVALID_PROVIDER_RESULT"
  | "RESULT_PERSISTENCE_UNCONFIRMED";

export class NotificationDeliveryDispatchExecutionError extends Error {
  readonly code: NotificationDeliveryDispatchExecutionErrorCode;

  constructor(code: NotificationDeliveryDispatchExecutionErrorCode) {
    super("Notification delivery dispatch execution failed closed");
    this.name = "NotificationDeliveryDispatchExecutionError";
    this.code = code;
  }
}

function attemptRecord(
  attempt: NotificationDeliveryDispatchAttempt,
  result: NotificationDeliveryResult,
): NotificationDeliveryAttemptRecord {
  return {
    schemaVersion: 1,
    deliveryId: attempt.deliveryId,
    attemptNumber: attempt.attemptNumber,
    attemptedAt: attempt.attemptedAt,
    result,
  };
}

function requireAttemptStillNext(
  history: NotificationDeliveryAttemptHistory,
  attempt: NotificationDeliveryDispatchAttempt,
): void {
  try {
    // In-memory only. The merged lifecycle validates the complete prior history,
    // delivery identity, finality and exact next attempt number. A delivered
    // probe is used only to prove that this exact attempt slot is still legal;
    // no evidence is persisted here.
    appendNotificationDeliveryAttempt(
      history,
      attemptRecord(attempt, { kind: "DELIVERED" }),
    );
  } catch {
    throw new NotificationDeliveryDispatchExecutionError("ATTEMPT_STATE_MISMATCH");
  }
}

function validateProviderResult(
  history: NotificationDeliveryAttemptHistory,
  attempt: NotificationDeliveryDispatchAttempt,
  result: NotificationDeliveryResult,
): NotificationDeliveryAttemptRecord {
  const record = attemptRecord(attempt, result);

  try {
    // This validates the runtime adapter result through the canonical lifecycle,
    // including supported result kinds/reasons and exact sequence/finality.
    appendNotificationDeliveryAttempt(history, record);
  } catch {
    throw new NotificationDeliveryDispatchExecutionError("INVALID_PROVIDER_RESULT");
  }

  return record;
}

/**
 * Execute at most one provider-neutral dispatch attempt under a durable replay
 * barrier. This helper is intentionally detached from Worker/Queue runtime.
 *
 * Trust order:
 * durable history -> atomic dispatch claim -> durable history re-check ->
 * one adapter invocation -> canonical result validation -> durable result.
 *
 * A provider exception or unconfirmed result persistence is ambiguous. The
 * durable claim remains the barrier and this function never synthesizes a
 * retryable result from an ambiguous outcome.
 */
export async function executeNotificationDeliveryDispatch(
  attempt: NotificationDeliveryDispatchAttempt,
  dependencies: NotificationDeliveryDispatchExecutionDependencies,
): Promise<NotificationDeliveryDispatchExecutionResult> {
  const beforeClaim = await dependencies.attemptStore.readHistory(attempt.deliveryId);
  requireAttemptStillNext(beforeClaim, attempt);

  let claim: Awaited<ReturnType<NotificationDeliveryDispatchClaimStore["claim"]>>;
  try {
    claim = await dependencies.claimStore.claim(attempt);
  } catch {
    throw new NotificationDeliveryDispatchExecutionError("CLAIM_UNCONFIRMED");
  }

  if (claim.kind === "ALREADY_CLAIMED") {
    return {
      kind: "ALREADY_CLAIMED",
      dispatchId: attempt.dispatchId,
      attemptNumber: attempt.attemptNumber,
    };
  }
  if (claim.kind !== "CLAIMED") {
    throw new NotificationDeliveryDispatchExecutionError("CLAIM_UNCONFIRMED");
  }

  // Re-read after the atomic claim and before crossing the provider boundary.
  // If durable attempt state moved unexpectedly, the claim is intentionally
  // left consumed and no provider invocation occurs.
  const afterClaim = await dependencies.attemptStore.readHistory(attempt.deliveryId);
  requireAttemptStillNext(afterClaim, attempt);

  let providerResult: NotificationDeliveryResult;
  try {
    providerResult = await dependencies.adapter.deliver(attempt);
  } catch {
    throw new NotificationDeliveryDispatchExecutionError("PROVIDER_OUTCOME_AMBIGUOUS");
  }

  const record = validateProviderResult(afterClaim, attempt, providerResult);

  try {
    const persistence = await dependencies.attemptStore.append(record);
    if (persistence.kind !== "APPENDED" && persistence.kind !== "DUPLICATE") {
      throw new Error("unsupported append result");
    }

    return {
      kind: "RECORDED",
      dispatchId: attempt.dispatchId,
      attemptNumber: attempt.attemptNumber,
      result: providerResult,
      persistence: persistence.kind,
    };
  } catch {
    throw new NotificationDeliveryDispatchExecutionError(
      "RESULT_PERSISTENCE_UNCONFIRMED",
    );
  }
}
