import type { NotificationDeliveryAttemptStore } from "./notification-delivery-attempt-store.js";
import {
  notificationDeliveryDispatchDecision,
  type NotificationDeliveryDispatchDecision,
} from "./notification-delivery-dispatch-decision.js";
import type { NotificationDeliveryIntentRecoveryReader } from "./notification-delivery-intent-store.js";
import type { NotificationDeliveryRetryPolicy } from "./notification-delivery-retry-policy.js";
import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
} from "./notification-delivery.js";
import type { NotificationCandidate } from "./notification-transition.js";

export interface NotificationDeliveryDispatchPlanDependencies {
  readonly intentReader: NotificationDeliveryIntentRecoveryReader;
  readonly attemptHistoryReader: Pick<NotificationDeliveryAttemptStore, "readHistory">;
}

export type NotificationDeliveryDispatchPlanResult =
  | { readonly kind: "NOT_FOUND" }
  | {
      readonly kind: "FOUND";
      readonly envelope: NotificationDeliveryEnvelope;
      readonly queuedAt: string;
      readonly decision: NotificationDeliveryDispatchDecision;
    };

export type NotificationDeliveryDispatchPlanErrorCode =
  | "INVALID_INPUT"
  | "INTENT_EVIDENCE_MISMATCH"
  | "UNSUPPORTED_INTENT_EVIDENCE";

export class NotificationDeliveryDispatchPlanError extends Error {
  readonly code: NotificationDeliveryDispatchPlanErrorCode;

  constructor(code: NotificationDeliveryDispatchPlanErrorCode) {
    super("Notification delivery dispatch planning failed closed");
    this.name = "NotificationDeliveryDispatchPlanError";
    this.code = code;
  }
}

const DELIVERY_ID_PATTERN = /^delivery-v1-[0-9a-f]{16}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function requireDeliveryId(value: unknown): string {
  if (typeof value !== "string" || !DELIVERY_ID_PATTERN.test(value)) {
    throw new NotificationDeliveryDispatchPlanError("INVALID_INPUT");
  }
  return value;
}

function requireUtcTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new NotificationDeliveryDispatchPlanError("INVALID_INPUT");
  }
  return new Date(value).toISOString();
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

function normalizeRecoveredEnvelope(
  value: NotificationDeliveryEnvelope,
  requestedDeliveryId: string,
): NotificationDeliveryEnvelope {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new NotificationDeliveryDispatchPlanError("INTENT_EVIDENCE_MISMATCH");
  }

  let expected: NotificationDeliveryEnvelope;
  try {
    expected = notificationDeliveryEnvelope(candidateFromEnvelope(value), value.targetKey);
  } catch {
    throw new NotificationDeliveryDispatchPlanError("INTENT_EVIDENCE_MISMATCH");
  }

  if (
    value.deliveryId !== requestedDeliveryId ||
    value.deliveryId !== expected.deliveryId ||
    value.transitionId !== expected.transitionId ||
    value.targetKey !== expected.targetKey ||
    value.signal !== expected.signal ||
    value.decisionId !== expected.decisionId ||
    value.projectId !== expected.projectId ||
    value.reference !== expected.reference ||
    value.title !== expected.title ||
    value.body !== expected.body ||
    value.deepLinkPath !== expected.deepLinkPath
  ) {
    throw new NotificationDeliveryDispatchPlanError("INTENT_EVIDENCE_MISMATCH");
  }

  return expected;
}

function validateDependencies(
  dependencies: NotificationDeliveryDispatchPlanDependencies,
): NotificationDeliveryDispatchPlanDependencies {
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    !dependencies.intentReader ||
    typeof dependencies.intentReader.read !== "function" ||
    !dependencies.attemptHistoryReader ||
    typeof dependencies.attemptHistoryReader.readHistory !== "function"
  ) {
    throw new NotificationDeliveryDispatchPlanError("INVALID_INPUT");
  }
  return dependencies;
}

/**
 * Build provider-neutral dispatch planning evidence from durable read-only state.
 *
 * This function never claims a dispatch, invokes a provider, appends evidence,
 * schedules work or mutates runtime state. Even a `READY` decision remains only
 * planning evidence and must still pass the restart-safe coordinator/claim gates
 * before any future provider boundary.
 */
export async function planNotificationDeliveryDispatch(
  deliveryIdInput: string,
  observedAtInput: string,
  retryPolicy: NotificationDeliveryRetryPolicy,
  dependenciesInput: NotificationDeliveryDispatchPlanDependencies,
): Promise<NotificationDeliveryDispatchPlanResult> {
  const deliveryId = requireDeliveryId(deliveryIdInput);
  const observedAt = requireUtcTimestamp(observedAtInput);
  const dependencies = validateDependencies(dependenciesInput);

  const evidence = await dependencies.intentReader.read(deliveryId);
  if (!evidence || typeof evidence !== "object") {
    throw new NotificationDeliveryDispatchPlanError("UNSUPPORTED_INTENT_EVIDENCE");
  }

  if (evidence.kind === "NOT_FOUND") return { kind: "NOT_FOUND" };
  if (evidence.kind !== "FOUND" || !evidence.intent || typeof evidence.intent !== "object") {
    throw new NotificationDeliveryDispatchPlanError("UNSUPPORTED_INTENT_EVIDENCE");
  }

  const envelope = normalizeRecoveredEnvelope(evidence.intent.envelope, deliveryId);
  const queuedAt = requireUtcTimestamp(evidence.intent.queuedAt);
  const history = await dependencies.attemptHistoryReader.readHistory(deliveryId);
  const decision = notificationDeliveryDispatchDecision({
    deliveryId,
    queuedAt,
    observedAt,
    history,
    retryPolicy,
  });

  return {
    kind: "FOUND",
    envelope,
    queuedAt,
    decision,
  };
}
