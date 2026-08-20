import {
  appendNotificationDeliveryAttempt,
  notificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptRecord,
} from "../../shared/notification-delivery-attempt.js";
import type {
  NotificationDeliveryAttemptAppendResult,
  NotificationDeliveryAttemptStore,
} from "../../shared/notification-delivery-attempt-store.js";
import type {
  NotificationDeliveryResult,
  NotificationDeliveryRetryReason,
  NotificationDeliveryTerminalReason,
} from "../../shared/notification-delivery.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

const READ_HISTORY_SQL = `
SELECT
  delivery_id,
  attempt_number,
  schema_version,
  attempted_at,
  result_kind,
  result_reason
FROM notification_delivery_attempts
WHERE delivery_id = ?1
ORDER BY attempt_number ASC
`.trim();

const INSERT_ATTEMPT_SQL = `
INSERT INTO notification_delivery_attempts (
  delivery_id,
  attempt_number,
  schema_version,
  attempted_at,
  result_kind,
  result_reason
) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT(delivery_id, attempt_number) DO NOTHING
`.trim();

const READ_ATTEMPT_SQL = `
SELECT
  delivery_id,
  attempt_number,
  schema_version,
  attempted_at,
  result_kind,
  result_reason
FROM notification_delivery_attempts
WHERE delivery_id = ?1 AND attempt_number = ?2
LIMIT 1
`.trim();

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

interface StoredAttemptRow {
  readonly delivery_id: string;
  readonly attempt_number: number;
  readonly schema_version: number;
  readonly attempted_at: string;
  readonly result_kind: string;
  readonly result_reason: string | null;
}

export class D1NotificationDeliveryAttemptStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1NotificationDeliveryAttemptStoreError";
  }
}

function requireSuccessfulResult<Row>(result: D1RunResultLike<Row>, operation: string): void {
  if (result.success !== true) {
    throw new D1NotificationDeliveryAttemptStoreError(`D1 ${operation} did not report success`);
  }
}

function parseResult(row: StoredAttemptRow): NotificationDeliveryResult {
  if (row.result_kind === "DELIVERED" && row.result_reason === null) {
    return { kind: "DELIVERED" };
  }

  if (
    row.result_kind === "RETRYABLE_FAILURE" &&
    typeof row.result_reason === "string" &&
    retryReasons.has(row.result_reason as NotificationDeliveryRetryReason)
  ) {
    return {
      kind: "RETRYABLE_FAILURE",
      reason: row.result_reason as NotificationDeliveryRetryReason,
    };
  }

  if (
    row.result_kind === "TERMINAL_FAILURE" &&
    typeof row.result_reason === "string" &&
    terminalReasons.has(row.result_reason as NotificationDeliveryTerminalReason)
  ) {
    return {
      kind: "TERMINAL_FAILURE",
      reason: row.result_reason as NotificationDeliveryTerminalReason,
    };
  }

  throw new D1NotificationDeliveryAttemptStoreError(
    "stored notification delivery attempt result is malformed",
  );
}

function parseStoredAttempt(row: StoredAttemptRow): NotificationDeliveryAttemptRecord {
  if (!row || typeof row !== "object" || row.schema_version !== 1) {
    throw new D1NotificationDeliveryAttemptStoreError(
      "stored notification delivery attempt schema version is unsupported",
    );
  }

  return {
    schemaVersion: 1,
    deliveryId: row.delivery_id,
    attemptNumber: row.attempt_number,
    attemptedAt: row.attempted_at,
    result: parseResult(row),
  };
}

function resultColumns(result: NotificationDeliveryResult): readonly [string, string | null] {
  if (result.kind === "DELIVERED") return [result.kind, null];
  return [result.kind, result.reason];
}

function sameResult(left: NotificationDeliveryResult, right: NotificationDeliveryResult): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "DELIVERED" && right.kind === "DELIVERED") return true;
  if (left.kind === "RETRYABLE_FAILURE" && right.kind === "RETRYABLE_FAILURE") {
    return left.reason === right.reason;
  }
  if (left.kind === "TERMINAL_FAILURE" && right.kind === "TERMINAL_FAILURE") {
    return left.reason === right.reason;
  }
  return false;
}

function sameAttempt(
  left: NotificationDeliveryAttemptRecord,
  right: NotificationDeliveryAttemptRecord,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.deliveryId === right.deliveryId &&
    left.attemptNumber === right.attemptNumber &&
    left.attemptedAt === right.attemptedAt &&
    sameResult(left.result, right.result)
  );
}

function appendValidated(
  history: NotificationDeliveryAttemptHistory,
  attempt: NotificationDeliveryAttemptRecord,
): NotificationDeliveryAttemptHistory {
  try {
    return appendNotificationDeliveryAttempt(history, attempt);
  } catch {
    throw new D1NotificationDeliveryAttemptStoreError(
      "notification delivery attempt violates the provider-neutral lifecycle",
    );
  }
}

export class D1NotificationDeliveryAttemptStore implements NotificationDeliveryAttemptStore {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async readHistory(deliveryId: string): Promise<NotificationDeliveryAttemptHistory> {
    let history: NotificationDeliveryAttemptHistory;
    try {
      history = notificationDeliveryAttemptHistory(deliveryId);
    } catch {
      throw new D1NotificationDeliveryAttemptStoreError("notification delivery id is malformed");
    }

    const read = await this.#database
      .prepare(READ_HISTORY_SQL)
      .bind(deliveryId)
      .run<StoredAttemptRow>();

    requireSuccessfulResult(read, "notification delivery attempt history read");

    for (const row of read.results) {
      history = appendValidated(history, parseStoredAttempt(row));
    }

    return history;
  }

  async append(
    attempt: NotificationDeliveryAttemptRecord,
  ): Promise<NotificationDeliveryAttemptAppendResult> {
    const history = await this.readHistory(attempt.deliveryId);
    const existing = history.attempts[attempt.attemptNumber - 1];

    if (existing) {
      if (sameAttempt(existing, attempt)) return { kind: "DUPLICATE" };
      throw new D1NotificationDeliveryAttemptStoreError(
        "notification delivery attempt number already has different durable evidence",
      );
    }

    appendValidated(history, attempt);
    const [resultKind, resultReason] = resultColumns(attempt.result);

    const insert = await this.#database
      .prepare(INSERT_ATTEMPT_SQL)
      .bind(
        attempt.deliveryId,
        attempt.attemptNumber,
        attempt.schemaVersion,
        attempt.attemptedAt,
        resultKind,
        resultReason,
      )
      .run();

    requireSuccessfulResult(insert, "notification delivery attempt insert");
    if (insert.meta.changes === 1) return { kind: "APPENDED" };
    if (insert.meta.changes !== 0) {
      throw new D1NotificationDeliveryAttemptStoreError(
        "D1 notification delivery attempt insert returned an unexpected change count",
      );
    }

    const durable = await this.#database
      .prepare(READ_ATTEMPT_SQL)
      .bind(attempt.deliveryId, attempt.attemptNumber)
      .run<StoredAttemptRow>();

    requireSuccessfulResult(durable, "notification delivery attempt collision read");
    if (durable.results.length !== 1) {
      throw new D1NotificationDeliveryAttemptStoreError(
        "D1 notification delivery attempt collision could not be uniquely proven",
      );
    }

    const stored = parseStoredAttempt(durable.results[0]);
    if (!sameAttempt(stored, attempt)) {
      throw new D1NotificationDeliveryAttemptStoreError(
        "D1 duplicate notification delivery attempt does not match durable evidence",
      );
    }

    return { kind: "DUPLICATE" };
  }
}
