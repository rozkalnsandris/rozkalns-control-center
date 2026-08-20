import {
  notificationDeliveryAttemptCanRetry,
  type NotificationDeliveryAttemptHistory,
} from "./notification-delivery-attempt.js";

export interface NotificationDeliveryRetryPolicy {
  readonly schemaVersion: 1;
  readonly maxAttempts: number;
  readonly retryDelaysSeconds: readonly number[];
}

export type NotificationDeliveryRetryDecision =
  | { readonly kind: "NOT_RETRY_ELIGIBLE" }
  | {
      readonly kind: "EXHAUSTED";
      readonly attemptCount: number;
      readonly maxAttempts: number;
    }
  | {
      readonly kind: "RETRY_AT";
      readonly nextAttemptNumber: number;
      readonly delaySeconds: number;
      readonly eligibleAt: string;
    };

export type NotificationDeliveryRetryPolicyErrorCode = "INVALID_POLICY";

export class NotificationDeliveryRetryPolicyError extends Error {
  readonly code: NotificationDeliveryRetryPolicyErrorCode;

  constructor(code: NotificationDeliveryRetryPolicyErrorCode) {
    super("Notification delivery retry policy validation failed");
    this.name = "NotificationDeliveryRetryPolicyError";
    this.code = code;
  }
}

const MAX_ATTEMPTS = 8;
const MAX_RETRY_DELAY_SECONDS = 86_400;

function normalizePolicy(policy: NotificationDeliveryRetryPolicy): NotificationDeliveryRetryPolicy {
  if (!policy || typeof policy !== "object") {
    throw new NotificationDeliveryRetryPolicyError("INVALID_POLICY");
  }

  const candidate = policy as Partial<NotificationDeliveryRetryPolicy>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.maxAttempts !== "number" ||
    !Number.isSafeInteger(candidate.maxAttempts) ||
    candidate.maxAttempts < 1 ||
    candidate.maxAttempts > MAX_ATTEMPTS ||
    !Array.isArray(candidate.retryDelaysSeconds) ||
    candidate.retryDelaysSeconds.length !== candidate.maxAttempts - 1
  ) {
    throw new NotificationDeliveryRetryPolicyError("INVALID_POLICY");
  }

  for (const delaySeconds of candidate.retryDelaysSeconds) {
    if (
      typeof delaySeconds !== "number" ||
      !Number.isSafeInteger(delaySeconds) ||
      delaySeconds < 1 ||
      delaySeconds > MAX_RETRY_DELAY_SECONDS
    ) {
      throw new NotificationDeliveryRetryPolicyError("INVALID_POLICY");
    }
  }

  return {
    schemaVersion: 1,
    maxAttempts: candidate.maxAttempts,
    retryDelaysSeconds: [...candidate.retryDelaysSeconds],
  };
}

/**
 * Evaluate retry timing from immutable attempt evidence and an explicit policy.
 * There is intentionally no implicit production policy, wall-clock dependency,
 * random jitter, provider-specific behavior or hidden mutable state here.
 */
export function notificationDeliveryRetryDecision(
  history: NotificationDeliveryAttemptHistory,
  policy: NotificationDeliveryRetryPolicy,
): NotificationDeliveryRetryDecision {
  const normalizedPolicy = normalizePolicy(policy);

  // The merged attempt lifecycle owns history validation. Any malformed history
  // fails closed there before this policy can emit scheduling evidence.
  if (!notificationDeliveryAttemptCanRetry(history)) {
    return { kind: "NOT_RETRY_ELIGIBLE" };
  }

  const attemptCount = history.attempts.length;
  if (attemptCount >= normalizedPolicy.maxAttempts) {
    return {
      kind: "EXHAUSTED",
      attemptCount,
      maxAttempts: normalizedPolicy.maxAttempts,
    };
  }

  const lastAttempt = history.attempts[attemptCount - 1];
  const delaySeconds = normalizedPolicy.retryDelaysSeconds[attemptCount - 1];
  if (!lastAttempt || delaySeconds === undefined) {
    throw new NotificationDeliveryRetryPolicyError("INVALID_POLICY");
  }

  const attemptedAtMilliseconds = Date.parse(lastAttempt.attemptedAt);
  const eligibleAt = new Date(attemptedAtMilliseconds + delaySeconds * 1_000).toISOString();

  return {
    kind: "RETRY_AT",
    nextAttemptNumber: attemptCount + 1,
    delaySeconds,
    eligibleAt,
  };
}
