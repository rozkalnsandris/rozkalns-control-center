import {
  notificationDeliveryDispatchId,
  type NotificationDeliveryDispatchAttempt,
} from "../../shared/notification-delivery-dispatch-attempt.js";
import type {
  NotificationDeliveryDispatchClaimEvidence,
  NotificationDeliveryDispatchClaimReader,
  NotificationDeliveryDispatchClaimResult,
  NotificationDeliveryDispatchClaimStore,
} from "../../shared/notification-delivery-dispatch-claim-store.js";
import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
} from "../../shared/notification-delivery.js";
import type { NotificationCandidate } from "../../shared/notification-transition.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TRANSITION_ID_PATTERN = /^[a-z0-9-]{32,80}$/;
const TARGET_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,63})$/;

const INSERT_CLAIM_SQL = `
INSERT INTO notification_delivery_dispatch_claims (
  dispatch_id,
  schema_version,
  delivery_id,
  attempt_number,
  transition_id,
  target_key,
  attempted_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT DO NOTHING
`.trim();

const READ_CLAIM_SQL = `
SELECT
  dispatch_id,
  schema_version,
  delivery_id,
  attempt_number,
  transition_id,
  target_key,
  attempted_at
FROM notification_delivery_dispatch_claims
WHERE dispatch_id = ?1
LIMIT 1
`.trim();

interface StoredDispatchClaimRow {
  readonly dispatch_id: string;
  readonly schema_version: number;
  readonly delivery_id: string;
  readonly attempt_number: number;
  readonly transition_id: string;
  readonly target_key: string;
  readonly attempted_at: string;
}

interface NormalizedDispatchClaim {
  readonly dispatchId: string;
  readonly schemaVersion: 1;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly transitionId: string;
  readonly targetKey: string;
  readonly attemptedAt: string;
}

export class D1NotificationDeliveryDispatchClaimStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1NotificationDeliveryDispatchClaimStoreError";
  }
}

function requireSuccessfulResult<Row>(result: D1RunResultLike<Row>, operation: string): void {
  if (result.success !== true) {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      `D1 ${operation} did not report success`,
    );
  }
}

function requireUtcTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      `${field} must be a UTC ISO timestamp`,
    );
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
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "notification delivery envelope is malformed",
    );
  }

  let expected: NotificationDeliveryEnvelope;
  try {
    expected = notificationDeliveryEnvelope(candidateFromEnvelope(value), value.targetKey);
  } catch {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
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
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "notification delivery envelope does not match deterministic identity",
    );
  }

  return expected;
}

function normalizeAttempt(
  attempt: NotificationDeliveryDispatchAttempt,
): NormalizedDispatchClaim {
  if (!attempt || typeof attempt !== "object" || attempt.schemaVersion !== 1) {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "notification dispatch attempt is malformed",
    );
  }

  const envelope = normalizeEnvelope(attempt.envelope);
  if (attempt.deliveryId !== envelope.deliveryId) {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "notification dispatch delivery id does not match envelope",
    );
  }

  let expectedDispatchId: string;
  try {
    expectedDispatchId = notificationDeliveryDispatchId(
      attempt.deliveryId,
      attempt.attemptNumber,
    );
  } catch {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "notification dispatch identity is malformed",
    );
  }

  if (attempt.dispatchId !== expectedDispatchId) {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "notification dispatch id does not match deterministic identity",
    );
  }

  return {
    dispatchId: expectedDispatchId,
    schemaVersion: 1,
    deliveryId: envelope.deliveryId,
    attemptNumber: attempt.attemptNumber,
    transitionId: envelope.transitionId,
    targetKey: envelope.targetKey,
    attemptedAt: requireUtcTimestamp(attempt.attemptedAt, "attemptedAt"),
  };
}

function parseStoredClaim(row: StoredDispatchClaimRow): NormalizedDispatchClaim {
  if (!row || typeof row !== "object" || row.schema_version !== 1) {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "stored notification dispatch claim schema version is unsupported",
    );
  }
  if (!TRANSITION_ID_PATTERN.test(row.transition_id)) {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "stored notification dispatch transition id is malformed",
    );
  }
  if (!TARGET_KEY_PATTERN.test(row.target_key)) {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "stored notification dispatch target key is malformed",
    );
  }

  let expectedDispatchId: string;
  try {
    expectedDispatchId = notificationDeliveryDispatchId(
      row.delivery_id,
      row.attempt_number,
    );
  } catch {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "stored notification dispatch identity is malformed",
    );
  }
  if (row.dispatch_id !== expectedDispatchId) {
    throw new D1NotificationDeliveryDispatchClaimStoreError(
      "stored notification dispatch id does not match delivery attempt identity",
    );
  }

  return {
    dispatchId: row.dispatch_id,
    schemaVersion: 1,
    deliveryId: row.delivery_id,
    attemptNumber: row.attempt_number,
    transitionId: row.transition_id,
    targetKey: row.target_key,
    attemptedAt: requireUtcTimestamp(row.attempted_at, "stored attemptedAt"),
  };
}

function sameClaim(left: NormalizedDispatchClaim, right: NormalizedDispatchClaim): boolean {
  return (
    left.dispatchId === right.dispatchId &&
    left.schemaVersion === right.schemaVersion &&
    left.deliveryId === right.deliveryId &&
    left.attemptNumber === right.attemptNumber &&
    left.transitionId === right.transitionId &&
    left.targetKey === right.targetKey &&
    left.attemptedAt === right.attemptedAt
  );
}

export class D1NotificationDeliveryDispatchClaimStore
  implements NotificationDeliveryDispatchClaimStore, NotificationDeliveryDispatchClaimReader
{
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async read(
    attempt: NotificationDeliveryDispatchAttempt,
  ): Promise<NotificationDeliveryDispatchClaimEvidence> {
    const claim = normalizeAttempt(attempt);
    const existing = await this.#database
      .prepare(READ_CLAIM_SQL)
      .bind(claim.dispatchId)
      .run<StoredDispatchClaimRow>();

    requireSuccessfulResult(existing, "notification dispatch claim evidence read");
    if (existing.results.length === 0) return { kind: "NOT_CLAIMED" };
    if (existing.results.length !== 1) {
      throw new D1NotificationDeliveryDispatchClaimStoreError(
        "D1 notification dispatch claim evidence could not be uniquely proven",
      );
    }

    const stored = parseStoredClaim(existing.results[0]);
    if (!sameClaim(stored, claim)) {
      throw new D1NotificationDeliveryDispatchClaimStoreError(
        "D1 notification dispatch claim evidence does not match exact attempt",
      );
    }

    return { kind: "CLAIMED" };
  }

  async claim(
    attempt: NotificationDeliveryDispatchAttempt,
  ): Promise<NotificationDeliveryDispatchClaimResult> {
    const claim = normalizeAttempt(attempt);

    const insert = await this.#database
      .prepare(INSERT_CLAIM_SQL)
      .bind(
        claim.dispatchId,
        claim.schemaVersion,
        claim.deliveryId,
        claim.attemptNumber,
        claim.transitionId,
        claim.targetKey,
        claim.attemptedAt,
      )
      .run();

    requireSuccessfulResult(insert, "notification dispatch claim insert");
    if (insert.meta.changes === 1) return { kind: "CLAIMED" };
    if (insert.meta.changes !== 0) {
      throw new D1NotificationDeliveryDispatchClaimStoreError(
        "D1 notification dispatch claim insert returned an unexpected change count",
      );
    }

    const existing = await this.#database
      .prepare(READ_CLAIM_SQL)
      .bind(claim.dispatchId)
      .run<StoredDispatchClaimRow>();

    requireSuccessfulResult(existing, "notification dispatch claim collision read");
    if (existing.results.length !== 1) {
      throw new D1NotificationDeliveryDispatchClaimStoreError(
        "D1 notification dispatch collision could not be uniquely proven",
      );
    }

    const stored = parseStoredClaim(existing.results[0]);
    if (!sameClaim(stored, claim)) {
      throw new D1NotificationDeliveryDispatchClaimStoreError(
        "D1 duplicate notification dispatch claim does not match durable evidence",
      );
    }

    return { kind: "ALREADY_CLAIMED" };
  }
}
