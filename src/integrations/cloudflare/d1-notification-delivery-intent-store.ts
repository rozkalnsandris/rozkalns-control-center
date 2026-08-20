import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
} from "../../shared/notification-delivery.js";
import type {
  NotificationDeliveryIntent,
  NotificationDeliveryIntentEnqueueResult,
  NotificationDeliveryIntentStore,
} from "../../shared/notification-delivery-intent-store.js";
import type { NotificationCandidate } from "../../shared/notification-transition.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const INSERT_INTENT_SQL = `
INSERT INTO notification_delivery_intents (
  delivery_id,
  schema_version,
  transition_id,
  target_key,
  signal,
  decision_id,
  project_id,
  reference,
  title,
  body,
  deep_link_path,
  queued_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
ON CONFLICT(delivery_id) DO NOTHING
`.trim();

const READ_INTENT_SQL = `
SELECT
  delivery_id,
  schema_version,
  transition_id,
  target_key,
  signal,
  decision_id,
  project_id,
  reference,
  title,
  body,
  deep_link_path,
  queued_at
FROM notification_delivery_intents
WHERE delivery_id = ?1
LIMIT 1
`.trim();

interface StoredDeliveryIntentRow {
  readonly delivery_id: string;
  readonly schema_version: number;
  readonly transition_id: string;
  readonly target_key: string;
  readonly signal: string;
  readonly decision_id: string;
  readonly project_id: string;
  readonly reference: string;
  readonly title: string;
  readonly body: string;
  readonly deep_link_path: string;
  readonly queued_at: string;
}

interface NormalizedDeliveryIntent {
  readonly envelope: NotificationDeliveryEnvelope;
  readonly queuedAt: string;
}

export class D1NotificationDeliveryIntentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1NotificationDeliveryIntentStoreError";
  }
}

function requireSuccessfulResult<Row>(result: D1RunResultLike<Row>, operation: string): void {
  if (result.success !== true) {
    throw new D1NotificationDeliveryIntentStoreError(`D1 ${operation} did not report success`);
  }
}

function requireUtcTimestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !utcTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new D1NotificationDeliveryIntentStoreError(`${field} must be a UTC ISO timestamp`);
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

function normalizeEnvelope(value: NotificationDeliveryEnvelope): NotificationDeliveryEnvelope {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new D1NotificationDeliveryIntentStoreError("notification delivery envelope is malformed");
  }

  let expected: NotificationDeliveryEnvelope;
  try {
    expected = notificationDeliveryEnvelope(candidateFromEnvelope(value), value.targetKey);
  } catch {
    throw new D1NotificationDeliveryIntentStoreError(
      "notification delivery envelope failed provider-neutral validation",
    );
  }

  if (
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
    throw new D1NotificationDeliveryIntentStoreError(
      "notification delivery envelope does not match deterministic identity",
    );
  }

  return expected;
}

function normalizeIntent(input: NotificationDeliveryIntent): NormalizedDeliveryIntent {
  if (!input || typeof input !== "object") {
    throw new D1NotificationDeliveryIntentStoreError("notification delivery intent is malformed");
  }

  return {
    envelope: normalizeEnvelope(input.envelope),
    queuedAt: requireUtcTimestamp(input.queuedAt, "queuedAt"),
  };
}

function parseStoredIntent(row: StoredDeliveryIntentRow): NormalizedDeliveryIntent {
  if (!row || typeof row !== "object" || row.schema_version !== 1) {
    throw new D1NotificationDeliveryIntentStoreError(
      "stored notification delivery schema version is unsupported",
    );
  }

  return {
    envelope: normalizeEnvelope({
      schemaVersion: 1,
      deliveryId: row.delivery_id,
      transitionId: row.transition_id,
      targetKey: row.target_key,
      signal: row.signal as NotificationDeliveryEnvelope["signal"],
      decisionId: row.decision_id,
      projectId: row.project_id,
      reference: row.reference,
      title: row.title,
      body: row.body,
      deepLinkPath: row.deep_link_path,
    }),
    queuedAt: requireUtcTimestamp(row.queued_at, "stored queuedAt"),
  };
}

function sameEnvelope(
  left: NotificationDeliveryEnvelope,
  right: NotificationDeliveryEnvelope,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.deliveryId === right.deliveryId &&
    left.transitionId === right.transitionId &&
    left.targetKey === right.targetKey &&
    left.signal === right.signal &&
    left.decisionId === right.decisionId &&
    left.projectId === right.projectId &&
    left.reference === right.reference &&
    left.title === right.title &&
    left.body === right.body &&
    left.deepLinkPath === right.deepLinkPath
  );
}

export class D1NotificationDeliveryIntentStore implements NotificationDeliveryIntentStore {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async enqueue(input: NotificationDeliveryIntent): Promise<NotificationDeliveryIntentEnqueueResult> {
    const { envelope, queuedAt } = normalizeIntent(input);

    const insert = await this.#database
      .prepare(INSERT_INTENT_SQL)
      .bind(
        envelope.deliveryId,
        envelope.schemaVersion,
        envelope.transitionId,
        envelope.targetKey,
        envelope.signal,
        envelope.decisionId,
        envelope.projectId,
        envelope.reference,
        envelope.title,
        envelope.body,
        envelope.deepLinkPath,
        queuedAt,
      )
      .run();

    requireSuccessfulResult(insert, "notification delivery intent insert");
    if (insert.meta.changes === 1) return { kind: "ENQUEUED" };
    if (insert.meta.changes !== 0) {
      throw new D1NotificationDeliveryIntentStoreError(
        "D1 notification delivery intent insert returned an unexpected change count",
      );
    }

    const existing = await this.#database
      .prepare(READ_INTENT_SQL)
      .bind(envelope.deliveryId)
      .run<StoredDeliveryIntentRow>();

    requireSuccessfulResult(existing, "notification delivery intent read");
    if (existing.results.length !== 1) {
      throw new D1NotificationDeliveryIntentStoreError(
        "D1 notification delivery intent identity could not be uniquely proven",
      );
    }

    const stored = parseStoredIntent(existing.results[0]);
    if (!sameEnvelope(stored.envelope, envelope)) {
      throw new D1NotificationDeliveryIntentStoreError(
        "D1 duplicate delivery id does not match the notification delivery envelope",
      );
    }

    return { kind: "DUPLICATE" };
  }
}
