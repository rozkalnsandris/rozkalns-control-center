import type { NotificationDeliveryAttemptHistory } from "./notification-delivery-attempt.js";
import {
  notificationDeliveryRetryDecision,
  type NotificationDeliveryRetryPolicy,
} from "./notification-delivery-retry-policy.js";

export interface NotificationDeliveryDispatchInput {
  readonly deliveryId: string;
  readonly queuedAt: string;
  readonly observedAt: string;
  readonly history: NotificationDeliveryAttemptHistory;
  readonly retryPolicy: NotificationDeliveryRetryPolicy;
}

export type NotificationDeliveryDispatchDecision =
  | {
      readonly kind: "READY";
      readonly attemptNumber: number;
      readonly eligibleAt: string;
    }
  | {
      readonly kind: "WAIT";
      readonly attemptNumber: number;
      readonly eligibleAt: string;
    }
  | {
      readonly kind: "EXHAUSTED";
      readonly attemptCount: number;
      readonly maxAttempts: number;
    }
  | { readonly kind: "DELIVERED" }
  | { readonly kind: "TERMINAL_FAILURE" };

export type NotificationDeliveryDispatchDecisionErrorCode =
  | "INVALID_TIMESTAMP"
  | "DELIVERY_ID_MISMATCH"
  | "INVALID_TIMELINE"
  | "INCONSISTENT_RETRY_STATE";

export class NotificationDeliveryDispatchDecisionError extends Error {
  readonly code: NotificationDeliveryDispatchDecisionErrorCode;

  constructor(code: NotificationDeliveryDispatchDecisionErrorCode) {
    super("Notification delivery dispatch decision validation failed");
    this.name = "NotificationDeliveryDispatchDecisionError";
    this.code = code;
  }
}

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function normalizeUtcTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new NotificationDeliveryDispatchDecisionError("INVALID_TIMESTAMP");
  }

  return new Date(value).toISOString();
}

function validateTimeline(history: NotificationDeliveryAttemptHistory, queuedAt: string): void {
  let priorAt = Date.parse(queuedAt);

  for (const attempt of history.attempts) {
    const attemptedAt = Date.parse(attempt.attemptedAt);
    if (attemptedAt < priorAt) {
      throw new NotificationDeliveryDispatchDecisionError("INVALID_TIMELINE");
    }
    priorAt = attemptedAt;
  }
}

function readiness(
  attemptNumber: number,
  eligibleAt: string,
  observedAt: string,
): NotificationDeliveryDispatchDecision {
  return Date.parse(observedAt) < Date.parse(eligibleAt)
    ? { kind: "WAIT", attemptNumber, eligibleAt }
    : { kind: "READY", attemptNumber, eligibleAt };
}

/**
 * Decide whether one provider-neutral delivery attempt is eligible from explicit,
 * immutable evidence only. This contract has no wall clock, scheduler, provider
 * invocation, persistence mutation or implicit production retry policy.
 */
export function notificationDeliveryDispatchDecision(
  input: NotificationDeliveryDispatchInput,
): NotificationDeliveryDispatchDecision {
  if (!input || typeof input !== "object") {
    throw new NotificationDeliveryDispatchDecisionError("DELIVERY_ID_MISMATCH");
  }

  const queuedAt = normalizeUtcTimestamp(input.queuedAt);
  const observedAt = normalizeUtcTimestamp(input.observedAt);

  // The merged retry-policy/lifecycle contracts validate both the explicit
  // policy and the complete attempt history before any dispatch state is emitted.
  const retryDecision = notificationDeliveryRetryDecision(input.history, input.retryPolicy);

  if (input.deliveryId !== input.history.deliveryId) {
    throw new NotificationDeliveryDispatchDecisionError("DELIVERY_ID_MISMATCH");
  }

  validateTimeline(input.history, queuedAt);

  switch (input.history.status) {
    case "PENDING":
      if (retryDecision.kind !== "NOT_RETRY_ELIGIBLE") {
        throw new NotificationDeliveryDispatchDecisionError("INCONSISTENT_RETRY_STATE");
      }
      return readiness(1, queuedAt, observedAt);

    case "DELIVERED":
      if (retryDecision.kind !== "NOT_RETRY_ELIGIBLE") {
        throw new NotificationDeliveryDispatchDecisionError("INCONSISTENT_RETRY_STATE");
      }
      return { kind: "DELIVERED" };

    case "TERMINAL_FAILURE":
      if (retryDecision.kind !== "NOT_RETRY_ELIGIBLE") {
        throw new NotificationDeliveryDispatchDecisionError("INCONSISTENT_RETRY_STATE");
      }
      return { kind: "TERMINAL_FAILURE" };

    case "RETRY_ELIGIBLE":
      if (retryDecision.kind === "EXHAUSTED") {
        return {
          kind: "EXHAUSTED",
          attemptCount: retryDecision.attemptCount,
          maxAttempts: retryDecision.maxAttempts,
        };
      }
      if (retryDecision.kind === "RETRY_AT") {
        return readiness(retryDecision.nextAttemptNumber, retryDecision.eligibleAt, observedAt);
      }
      throw new NotificationDeliveryDispatchDecisionError("INCONSISTENT_RETRY_STATE");
  }
}
