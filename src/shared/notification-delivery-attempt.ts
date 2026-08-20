import type {
  NotificationDeliveryResult,
  NotificationDeliveryRetryReason,
  NotificationDeliveryTerminalReason,
} from "./notification-delivery.js";

export interface NotificationDeliveryAttemptRecord {
  readonly schemaVersion: 1;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly attemptedAt: string;
  readonly result: NotificationDeliveryResult;
}

export type NotificationDeliveryLifecycleStatus =
  | "PENDING"
  | "RETRY_ELIGIBLE"
  | "DELIVERED"
  | "TERMINAL_FAILURE";

export interface NotificationDeliveryAttemptHistory {
  readonly schemaVersion: 1;
  readonly deliveryId: string;
  readonly status: NotificationDeliveryLifecycleStatus;
  readonly attempts: readonly NotificationDeliveryAttemptRecord[];
}

export type NotificationDeliveryAttemptContractErrorCode =
  | "INVALID_DELIVERY_ID"
  | "INVALID_HISTORY"
  | "INVALID_ATTEMPT"
  | "DELIVERY_ID_MISMATCH"
  | "ATTEMPT_SEQUENCE_MISMATCH"
  | "FINAL_STATE";

export class NotificationDeliveryAttemptContractError extends Error {
  readonly code: NotificationDeliveryAttemptContractErrorCode;

  constructor(code: NotificationDeliveryAttemptContractErrorCode) {
    super("Notification delivery attempt lifecycle validation failed");
    this.name = "NotificationDeliveryAttemptContractError";
    this.code = code;
  }
}

const DELIVERY_ID_PATTERN = /^delivery-v1-[0-9a-f]{16}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const retryReasons = new Set<NotificationDeliveryRetryReason>([
  "RATE_LIMITED",
  "TRANSIENT_UPSTREAM",
  "PROVIDER_UNAVAILABLE",
]);

const terminalReasons = new Set<NotificationDeliveryTerminalReason>([
  "DESTINATION_INVALID",
  "PAYLOAD_REJECTED",
  "AUTHORIZATION_FAILED",
]);

function assertDeliveryId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DELIVERY_ID_PATTERN.test(value)) {
    throw new NotificationDeliveryAttemptContractError("INVALID_DELIVERY_ID");
  }
}

function validUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTC_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function assertResult(value: unknown): asserts value is NotificationDeliveryResult {
  if (!value || typeof value !== "object") {
    throw new NotificationDeliveryAttemptContractError("INVALID_ATTEMPT");
  }

  const result = value as Partial<NotificationDeliveryResult> & { reason?: unknown };
  if (result.kind === "DELIVERED") return;
  if (result.kind === "RETRYABLE_FAILURE" && retryReasons.has(result.reason as NotificationDeliveryRetryReason)) {
    return;
  }
  if (result.kind === "TERMINAL_FAILURE" && terminalReasons.has(result.reason as NotificationDeliveryTerminalReason)) {
    return;
  }

  throw new NotificationDeliveryAttemptContractError("INVALID_ATTEMPT");
}

function assertAttemptShape(value: unknown): asserts value is NotificationDeliveryAttemptRecord {
  if (!value || typeof value !== "object") {
    throw new NotificationDeliveryAttemptContractError("INVALID_ATTEMPT");
  }

  const attempt = value as Partial<NotificationDeliveryAttemptRecord>;
  if (
    attempt.schemaVersion !== 1 ||
    !Number.isSafeInteger(attempt.attemptNumber) ||
    (attempt.attemptNumber ?? 0) < 1 ||
    !validUtcTimestamp(attempt.attemptedAt)
  ) {
    throw new NotificationDeliveryAttemptContractError("INVALID_ATTEMPT");
  }

  assertDeliveryId(attempt.deliveryId);
  assertResult(attempt.result);
}

function statusForAttempts(
  deliveryId: string,
  attempts: readonly NotificationDeliveryAttemptRecord[],
): NotificationDeliveryLifecycleStatus {
  if (attempts.length === 0) return "PENDING";

  let priorResult: NotificationDeliveryResult | undefined;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    assertAttemptShape(attempt);

    if (attempt.deliveryId !== deliveryId) {
      throw new NotificationDeliveryAttemptContractError("INVALID_HISTORY");
    }
    if (attempt.attemptNumber !== index + 1) {
      throw new NotificationDeliveryAttemptContractError("INVALID_HISTORY");
    }
    if (priorResult && priorResult.kind !== "RETRYABLE_FAILURE") {
      throw new NotificationDeliveryAttemptContractError("INVALID_HISTORY");
    }

    priorResult = attempt.result;
  }

  const lastResult = attempts[attempts.length - 1].result;
  if (lastResult.kind === "DELIVERED") return "DELIVERED";
  if (lastResult.kind === "TERMINAL_FAILURE") return "TERMINAL_FAILURE";
  return "RETRY_ELIGIBLE";
}

function normalizeHistory(history: NotificationDeliveryAttemptHistory): NotificationDeliveryAttemptHistory {
  if (!history || typeof history !== "object" || history.schemaVersion !== 1 || !Array.isArray(history.attempts)) {
    throw new NotificationDeliveryAttemptContractError("INVALID_HISTORY");
  }

  assertDeliveryId(history.deliveryId);
  const status = statusForAttempts(history.deliveryId, history.attempts);
  if (history.status !== status) {
    throw new NotificationDeliveryAttemptContractError("INVALID_HISTORY");
  }

  return {
    schemaVersion: 1,
    deliveryId: history.deliveryId,
    status,
    attempts: [...history.attempts],
  };
}

export function notificationDeliveryAttemptHistory(
  deliveryId: string,
): NotificationDeliveryAttemptHistory {
  assertDeliveryId(deliveryId);
  return {
    schemaVersion: 1,
    deliveryId,
    status: "PENDING",
    attempts: [],
  };
}

export function appendNotificationDeliveryAttempt(
  history: NotificationDeliveryAttemptHistory,
  attempt: NotificationDeliveryAttemptRecord,
): NotificationDeliveryAttemptHistory {
  const current = normalizeHistory(history);
  assertAttemptShape(attempt);

  if (attempt.deliveryId !== current.deliveryId) {
    throw new NotificationDeliveryAttemptContractError("DELIVERY_ID_MISMATCH");
  }
  if (current.status === "DELIVERED" || current.status === "TERMINAL_FAILURE") {
    throw new NotificationDeliveryAttemptContractError("FINAL_STATE");
  }

  const expectedAttemptNumber = current.attempts.length + 1;
  if (attempt.attemptNumber !== expectedAttemptNumber) {
    throw new NotificationDeliveryAttemptContractError("ATTEMPT_SEQUENCE_MISMATCH");
  }

  const attempts = [...current.attempts, attempt];
  const status = statusForAttempts(current.deliveryId, attempts);
  return {
    schemaVersion: 1,
    deliveryId: current.deliveryId,
    status,
    attempts,
  };
}

export function notificationDeliveryAttemptCanRetry(
  history: NotificationDeliveryAttemptHistory,
): boolean {
  return normalizeHistory(history).status === "RETRY_ELIGIBLE";
}
