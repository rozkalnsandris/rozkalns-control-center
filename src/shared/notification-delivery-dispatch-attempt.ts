import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
  type NotificationDeliveryResult,
} from "./notification-delivery.js";
import type { NotificationDeliveryDispatchDecision } from "./notification-delivery-dispatch-decision.js";
import type { NotificationCandidate } from "./notification-transition.js";

export interface NotificationDeliveryDispatchAttempt {
  readonly schemaVersion: 1;
  readonly dispatchId: string;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly attemptedAt: string;
  readonly envelope: NotificationDeliveryEnvelope;
}

export interface NotificationDeliveryDispatchAdapter {
  deliver(attempt: NotificationDeliveryDispatchAttempt): Promise<NotificationDeliveryResult>;
}

export type NotificationDeliveryDispatchAttemptErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_DECISION"
  | "INVALID_TIMESTAMP"
  | "BEFORE_ELIGIBLE";

export class NotificationDeliveryDispatchAttemptError extends Error {
  readonly code: NotificationDeliveryDispatchAttemptErrorCode;

  constructor(code: NotificationDeliveryDispatchAttemptErrorCode) {
    super("Notification delivery dispatch attempt validation failed");
    this.name = "NotificationDeliveryDispatchAttemptError";
    this.code = code;
  }
}

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DELIVERY_ID_PATTERN = /^delivery-v1-([0-9a-f]{16})$/;
const MAX_ATTEMPT_NUMBER = 8;

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

function normalizeEnvelope(value: NotificationDeliveryEnvelope): NotificationDeliveryEnvelope {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new NotificationDeliveryDispatchAttemptError("INVALID_ENVELOPE");
  }

  let expected: NotificationDeliveryEnvelope;
  try {
    expected = notificationDeliveryEnvelope(candidateFromEnvelope(value), value.targetKey);
  } catch {
    throw new NotificationDeliveryDispatchAttemptError("INVALID_ENVELOPE");
  }

  if (
    value.deliveryId !== expected.deliveryId ||
    value.targetKey !== expected.targetKey ||
    value.transitionId !== expected.transitionId ||
    value.signal !== expected.signal ||
    value.decisionId !== expected.decisionId ||
    value.projectId !== expected.projectId ||
    value.reference !== expected.reference ||
    value.title !== expected.title ||
    value.body !== expected.body ||
    value.deepLinkPath !== expected.deepLinkPath
  ) {
    throw new NotificationDeliveryDispatchAttemptError("INVALID_ENVELOPE");
  }

  return expected;
}

function normalizeUtcTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new NotificationDeliveryDispatchAttemptError("INVALID_TIMESTAMP");
  }

  return new Date(value).toISOString();
}

function normalizeReadyDecision(
  decision: NotificationDeliveryDispatchDecision,
): Extract<NotificationDeliveryDispatchDecision, { readonly kind: "READY" }> {
  if (
    !decision ||
    typeof decision !== "object" ||
    decision.kind !== "READY" ||
    !Number.isSafeInteger(decision.attemptNumber) ||
    decision.attemptNumber < 1 ||
    decision.attemptNumber > MAX_ATTEMPT_NUMBER
  ) {
    throw new NotificationDeliveryDispatchAttemptError("INVALID_DECISION");
  }

  normalizeUtcTimestamp(decision.eligibleAt);
  return decision;
}

/** Deterministic non-secret identity for one exact delivery attempt. */
export function notificationDeliveryDispatchId(
  deliveryId: string,
  attemptNumber: number,
): string {
  const deliveryIdentity = DELIVERY_ID_PATTERN.exec(deliveryId);
  if (!deliveryIdentity) {
    throw new NotificationDeliveryDispatchAttemptError("INVALID_ENVELOPE");
  }
  if (
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1 ||
    attemptNumber > MAX_ATTEMPT_NUMBER
  ) {
    throw new NotificationDeliveryDispatchAttemptError("INVALID_DECISION");
  }

  return `dispatch-v1-${deliveryIdentity[1]}-${attemptNumber}`;
}

/**
 * Build one provider-neutral dispatch-attempt identity from already-validated
 * READY evidence. `dispatchId` is a bounded, non-secret replay/idempotency key
 * for future adapters; this helper performs no provider call or persistence.
 */
export function notificationDeliveryDispatchAttempt(
  envelopeInput: NotificationDeliveryEnvelope,
  decisionInput: NotificationDeliveryDispatchDecision,
  attemptedAtInput: string,
): NotificationDeliveryDispatchAttempt {
  const envelope = normalizeEnvelope(envelopeInput);
  const decision = normalizeReadyDecision(decisionInput);
  const eligibleAt = normalizeUtcTimestamp(decision.eligibleAt);
  const attemptedAt = normalizeUtcTimestamp(attemptedAtInput);

  if (Date.parse(attemptedAt) < Date.parse(eligibleAt)) {
    throw new NotificationDeliveryDispatchAttemptError("BEFORE_ELIGIBLE");
  }

  return {
    schemaVersion: 1,
    dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, decision.attemptNumber),
    deliveryId: envelope.deliveryId,
    attemptNumber: decision.attemptNumber,
    attemptedAt,
    envelope,
  };
}
