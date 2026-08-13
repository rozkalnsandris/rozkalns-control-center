import type { DeliveryClaim, DeliveryClaimStore } from "../../shared/github-reconciliation.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";

const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const opaqueIdentifierPattern = /^[A-Za-z0-9._:/+-]{1,200}$/;

const INSERT_CLAIM_SQL = `
INSERT INTO webhook_deliveries (
  delivery_id,
  repository,
  project_id,
  event_name,
  message_version,
  state,
  attempt_count,
  received_at,
  updated_at
) VALUES (?1, ?2, ?3, ?4, 1, 'RECEIVED', 0, ?5, ?5)
ON CONFLICT(delivery_id) DO NOTHING
`.trim();

const READ_DUPLICATE_SQL = `
SELECT delivery_id, repository, project_id, event_name
FROM webhook_deliveries
WHERE delivery_id = ?1
LIMIT 1
`.trim();

export interface D1RunMetaLike {
  readonly changes?: number;
}

export interface D1RunResultLike<Row = Record<string, unknown>> {
  readonly success: boolean;
  readonly meta: D1RunMetaLike;
  readonly results: readonly Row[];
}

export interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  run<Row = Record<string, unknown>>(): Promise<D1RunResultLike<Row>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

interface ExistingClaimRow {
  readonly delivery_id: string;
  readonly repository: string;
  readonly project_id: string;
  readonly event_name: string;
}

export class D1DeliveryClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1DeliveryClaimError";
  }
}

function requireOpaque(value: string, field: string): string {
  if (!opaqueIdentifierPattern.test(value)) {
    throw new D1DeliveryClaimError(`${field} is malformed`);
  }
  return value;
}

function requireUtcTimestamp(value: string): string {
  if (!utcTimestampPattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new D1DeliveryClaimError("claimedAt must be a UTC ISO timestamp");
  }
  return value;
}

function requireSuccessfulResult(result: D1RunResultLike, operation: string): void {
  if (result.success !== true) {
    throw new D1DeliveryClaimError(`D1 ${operation} did not report success`);
  }
}

export class D1DeliveryClaimStore implements DeliveryClaimStore {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async claim(delivery: DeliveryClaim): Promise<"claimed" | "duplicate"> {
    const deliveryId = requireOpaque(delivery.deliveryId, "deliveryId");
    const eventName = requireOpaque(delivery.eventName, "eventName");
    const project = requireManagedProjectPolicy(delivery.repository);
    const claimedAt = requireUtcTimestamp(delivery.claimedAt);

    const insert = await this.#database
      .prepare(INSERT_CLAIM_SQL)
      .bind(deliveryId, project.repository, project.id, eventName, claimedAt)
      .run();

    requireSuccessfulResult(insert, "delivery claim insert");

    if (insert.meta.changes === 1) return "claimed";
    if (insert.meta.changes !== 0) {
      throw new D1DeliveryClaimError("D1 delivery claim insert returned an unexpected change count");
    }

    const existing = await this.#database
      .prepare(READ_DUPLICATE_SQL)
      .bind(deliveryId)
      .run<ExistingClaimRow>();

    requireSuccessfulResult(existing, "duplicate delivery read");

    if (existing.results.length !== 1) {
      throw new D1DeliveryClaimError("D1 duplicate delivery identity could not be proven");
    }

    const row = existing.results[0];
    if (
      row.delivery_id !== deliveryId ||
      row.repository !== project.repository ||
      row.project_id !== project.id ||
      row.event_name !== eventName
    ) {
      throw new D1DeliveryClaimError("D1 duplicate delivery identity does not match the authenticated claim");
    }

    return "duplicate";
  }
}
