import {
  notificationDeliveryAttemptCanRetry,
  type NotificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptRecord,
} from "./notification-delivery-attempt.js";
import type { NotificationDeliveryAttemptStore } from "./notification-delivery-attempt-store.js";
import { notificationDeliveryDispatchId } from "./notification-delivery-dispatch-attempt.js";
import type {
  NotificationDeliveryDispatchClaimRecoveryEvidence,
  NotificationDeliveryDispatchClaimRecoveryReader,
  NotificationDeliveryDispatchClaimSnapshot,
} from "./notification-delivery-dispatch-claim-store.js";
import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
  type NotificationDeliveryResult,
} from "./notification-delivery.js";
import type { NotificationCandidate } from "./notification-transition.js";

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface NotificationDeliveryDispatchRecoveryDependencies {
  readonly attemptStore: NotificationDeliveryAttemptStore;
  readonly claimReader: NotificationDeliveryDispatchClaimRecoveryReader;
}

export type NotificationDeliveryDispatchRecoveryResult =
  | {
      /**
       * No durable claim or result exists for the next legal lifecycle slot.
       * This is evidence only, not provider-send permission; dispatch eligibility
       * must still be decided separately by the dispatch-decision contract.
       */
      readonly kind: "NOT_STARTED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
    }
  | {
      /** Existing durable claim with no exact result: replay barrier, never resend permission. */
      readonly kind: "AMBIGUOUS_CLAIMED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
      readonly attemptedAt: string;
    }
  | {
      readonly kind: "RECORDED";
      readonly dispatchId: string;
      readonly attemptNumber: number;
      readonly attemptedAt: string;
      readonly result: NotificationDeliveryResult;
    };

export type NotificationDeliveryDispatchRecoveryErrorCode =
  | "INVALID_REQUEST"
  | "ATTEMPT_EVIDENCE_UNCONFIRMED"
  | "ATTEMPT_STATE_MISMATCH"
  | "CLAIM_EVIDENCE_UNCONFIRMED"
  | "CLAIM_EVIDENCE_MISMATCH"
  | "RESULT_EVIDENCE_MISMATCH"
  | "UNCLAIMED_RESULT";

export class NotificationDeliveryDispatchRecoveryError extends Error {
  readonly code: NotificationDeliveryDispatchRecoveryErrorCode;

  constructor(code: NotificationDeliveryDispatchRecoveryErrorCode) {
    super("Notification delivery dispatch recovery failed closed");
    this.name = "NotificationDeliveryDispatchRecoveryError";
    this.code = code;
  }
}

interface NormalizedRecoveryRequest {
  readonly envelope: NotificationDeliveryEnvelope;
  readonly attemptNumber: number;
  readonly dispatchId: string;
}

function candidateFromEnvelope(envelope: NotificationDeliveryEnvelope): NotificationCandidate {
  return {
    schemaVersion: 1,
    signal: envelope.signal,
    transitionId: envelope.transitionId,
    decisionId: envelope.decisionId,
    projectId: envelope.projectId,
    reference: envelope.reference,
    title: envelope.title,
    body: envelope.body,
    deepLinkPath: envelope.deepLinkPath,
  };
}

function sameEnvelope(
  left: NotificationDeliveryEnvelope,
  right: NotificationDeliveryEnvelope,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.deliveryId === right.deliveryId &&
    left.targetKey === right.targetKey &&
    left.transitionId === right.transitionId &&
    left.signal === right.signal &&
    left.decisionId === right.decisionId &&
    left.projectId === right.projectId &&
    left.reference === right.reference &&
    left.title === right.title &&
    left.body === right.body &&
    left.deepLinkPath === right.deepLinkPath
  );
}

function normalizeRequest(
  envelopeInput: NotificationDeliveryEnvelope,
  attemptNumber: number,
): NormalizedRecoveryRequest {
  try {
    if (!envelopeInput || typeof envelopeInput !== "object" || envelopeInput.schemaVersion !== 1) {
      throw new Error("malformed envelope");
    }

    const envelope = notificationDeliveryEnvelope(
      candidateFromEnvelope(envelopeInput),
      envelopeInput.targetKey,
    );
    if (!sameEnvelope(envelopeInput, envelope)) {
      throw new Error("envelope identity drift");
    }

    return {
      envelope,
      attemptNumber,
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, attemptNumber),
    };
  } catch {
    throw new NotificationDeliveryDispatchRecoveryError("INVALID_REQUEST");
  }
}

function validateHistory(
  history: NotificationDeliveryAttemptHistory,
  request: NormalizedRecoveryRequest,
): NotificationDeliveryAttemptRecord | undefined {
  try {
    // Full lifecycle validation: schema, exact sequence, typed result and finality.
    notificationDeliveryAttemptCanRetry(history);
  } catch {
    throw new NotificationDeliveryDispatchRecoveryError("ATTEMPT_STATE_MISMATCH");
  }

  if (history.deliveryId !== request.envelope.deliveryId) {
    throw new NotificationDeliveryDispatchRecoveryError("ATTEMPT_STATE_MISMATCH");
  }

  const recorded = history.attempts[request.attemptNumber - 1];
  if (recorded) {
    if (
      recorded.deliveryId !== request.envelope.deliveryId ||
      recorded.attemptNumber !== request.attemptNumber
    ) {
      throw new NotificationDeliveryDispatchRecoveryError("RESULT_EVIDENCE_MISMATCH");
    }
    return recorded;
  }

  if (history.status === "DELIVERED" || history.status === "TERMINAL_FAILURE") {
    throw new NotificationDeliveryDispatchRecoveryError("ATTEMPT_STATE_MISMATCH");
  }

  if (request.attemptNumber !== history.attempts.length + 1) {
    throw new NotificationDeliveryDispatchRecoveryError("ATTEMPT_STATE_MISMATCH");
  }

  return undefined;
}

function normalizeUtcTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new NotificationDeliveryDispatchRecoveryError("CLAIM_EVIDENCE_MISMATCH");
  }
  return new Date(value).toISOString();
}

function normalizeClaimEvidence(
  evidence: NotificationDeliveryDispatchClaimRecoveryEvidence,
  request: NormalizedRecoveryRequest,
): NotificationDeliveryDispatchClaimRecoveryEvidence {
  if (!evidence || typeof evidence !== "object") {
    throw new NotificationDeliveryDispatchRecoveryError("CLAIM_EVIDENCE_UNCONFIRMED");
  }
  if (evidence.kind === "NOT_CLAIMED") return evidence;
  if (evidence.kind !== "CLAIMED" || !evidence.claim || typeof evidence.claim !== "object") {
    throw new NotificationDeliveryDispatchRecoveryError("CLAIM_EVIDENCE_UNCONFIRMED");
  }

  const claim: NotificationDeliveryDispatchClaimSnapshot = {
    schemaVersion: evidence.claim.schemaVersion,
    dispatchId: evidence.claim.dispatchId,
    deliveryId: evidence.claim.deliveryId,
    attemptNumber: evidence.claim.attemptNumber,
    transitionId: evidence.claim.transitionId,
    targetKey: evidence.claim.targetKey,
    attemptedAt: normalizeUtcTimestamp(evidence.claim.attemptedAt),
  };

  if (
    claim.schemaVersion !== 1 ||
    claim.dispatchId !== request.dispatchId ||
    claim.deliveryId !== request.envelope.deliveryId ||
    claim.attemptNumber !== request.attemptNumber ||
    claim.transitionId !== request.envelope.transitionId ||
    claim.targetKey !== request.envelope.targetKey
  ) {
    throw new NotificationDeliveryDispatchRecoveryError("CLAIM_EVIDENCE_MISMATCH");
  }

  return { kind: "CLAIMED", claim };
}

/**
 * Reconcile one delivery/attempt identity after restart using durable evidence.
 *
 * Unlike exact-attempt reconciliation, the caller does not supply `attemptedAt`.
 * If a durable claim exists, its original timestamp is recovered from the claim
 * store and remains the immutable replay barrier. No branch of this function
 * creates, expires, reclaims or authorizes a provider send.
 */
export async function recoverNotificationDeliveryDispatch(
  envelopeInput: NotificationDeliveryEnvelope,
  attemptNumber: number,
  dependencies: NotificationDeliveryDispatchRecoveryDependencies,
): Promise<NotificationDeliveryDispatchRecoveryResult> {
  const request = normalizeRequest(envelopeInput, attemptNumber);

  let history: NotificationDeliveryAttemptHistory;
  try {
    history = await dependencies.attemptStore.readHistory(request.envelope.deliveryId);
  } catch {
    throw new NotificationDeliveryDispatchRecoveryError("ATTEMPT_EVIDENCE_UNCONFIRMED");
  }

  const recorded = validateHistory(history, request);

  let claimEvidence: NotificationDeliveryDispatchClaimRecoveryEvidence;
  try {
    claimEvidence = normalizeClaimEvidence(
      await dependencies.claimReader.readSnapshot(
        request.envelope.deliveryId,
        request.attemptNumber,
      ),
      request,
    );
  } catch (error) {
    if (error instanceof NotificationDeliveryDispatchRecoveryError) throw error;
    throw new NotificationDeliveryDispatchRecoveryError("CLAIM_EVIDENCE_UNCONFIRMED");
  }

  if (recorded) {
    if (claimEvidence.kind !== "CLAIMED") {
      throw new NotificationDeliveryDispatchRecoveryError("UNCLAIMED_RESULT");
    }
    if (recorded.attemptedAt !== claimEvidence.claim.attemptedAt) {
      throw new NotificationDeliveryDispatchRecoveryError("RESULT_EVIDENCE_MISMATCH");
    }

    return {
      kind: "RECORDED",
      dispatchId: request.dispatchId,
      attemptNumber: request.attemptNumber,
      attemptedAt: claimEvidence.claim.attemptedAt,
      result: recorded.result,
    };
  }

  if (claimEvidence.kind === "CLAIMED") {
    const previous = history.attempts[history.attempts.length - 1];
    if (
      previous &&
      Date.parse(claimEvidence.claim.attemptedAt) < Date.parse(previous.attemptedAt)
    ) {
      throw new NotificationDeliveryDispatchRecoveryError("ATTEMPT_STATE_MISMATCH");
    }

    return {
      kind: "AMBIGUOUS_CLAIMED",
      dispatchId: request.dispatchId,
      attemptNumber: request.attemptNumber,
      attemptedAt: claimEvidence.claim.attemptedAt,
    };
  }

  return {
    kind: "NOT_STARTED",
    dispatchId: request.dispatchId,
    attemptNumber: request.attemptNumber,
  };
}
