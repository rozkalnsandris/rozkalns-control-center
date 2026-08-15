import type { DeliveryClaim, DeliveryClaimStore } from "../../shared/github-reconciliation.js";
import type { DeliveryLifecycleState } from "../../shared/reconciliation-durability.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";

const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const opaqueIdentifierPattern = /^[A-Za-z0-9._:/+-]{1,200}$/;
const deliveryStates = new Set<DeliveryLifecycleState>([
  "RECEIVED",
  "ENQUEUED",
  "PROCESSING",
  "RETRY_PENDING",
  "SUCCEEDED",
  "DEAD_LETTERED",
]);

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

const READ_DELIVERY_SQL = `
SELECT
  delivery_id,
  repository,
  project_id,
  event_name,
  message_version,
  state,
  received_at
FROM webhook_deliveries
WHERE delivery_id = ?1
LIMIT 1
`.trim();

const MARK_ENQUEUED_SQL = `
UPDATE webhook_deliveries
SET
  state = 'ENQUEUED',
  enqueued_at = ?5,
  updated_at = ?5
WHERE
  delivery_id = ?1
  AND repository = ?2
  AND project_id = ?3
  AND event_name = ?4
  AND state = 'RECEIVED'
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
  readonly message_version: number;
  readonly state: string;
  readonly received_at: string;
}

export interface DurableClaimedDelivery {
  readonly deliveryId: string;
  readonly repository: string;
  readonly projectId: string;
  readonly eventName: string;
  readonly messageVersion: 1;
  readonly state: DeliveryLifecycleState;
  readonly receivedAt: string;
}

export interface RecoverableDeliveryClaimStore extends DeliveryClaimStore {
  readDelivery(deliveryId: string): Promise<DurableClaimedDelivery>;
  markEnqueued(delivery: DeliveryClaim, enqueuedAt: string): Promise<void>;
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

function requireUtcTimestamp(value: string, field = "timestamp"): string {
  if (!utcTimestampPattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new D1DeliveryClaimError(`${field} must be a UTC ISO timestamp`);
  }
  return value;
}

function requireSuccessfulResult<Row>(result: D1RunResultLike<Row>, operation: string): void {
  if (result.success !== true) {
    throw new D1DeliveryClaimError(`D1 ${operation} did not report success`);
  }
}

function claimIdentity(delivery: DeliveryClaim) {
  const deliveryId = requireOpaque(delivery.deliveryId, "deliveryId");
  const eventName = requireOpaque(delivery.eventName, "eventName");
  const project = requireManagedProjectPolicy(delivery.repository);
  const claimedAt = requireUtcTimestamp(delivery.claimedAt, "claimedAt");
  return { deliveryId, eventName, project, claimedAt };
}

function durableDelivery(row: ExistingClaimRow): DurableClaimedDelivery {
  const deliveryId = requireOpaque(row.delivery_id, "stored deliveryId");
  const eventName = requireOpaque(row.event_name, "stored eventName");
  const project = requireManagedProjectPolicy(row.repository);
  if (row.project_id !== project.id) {
    throw new D1DeliveryClaimError("D1 delivery project does not match repository policy");
  }
  if (row.message_version !== 1) {
    throw new D1DeliveryClaimError("D1 delivery message version is unsupported");
  }
  if (!deliveryStates.has(row.state as DeliveryLifecycleState)) {
    throw new D1DeliveryClaimError("D1 delivery state is unsupported");
  }

  return {
    deliveryId,
    repository: project.repository,
    projectId: project.id,
    eventName,
    messageVersion: 1,
    state: row.state as DeliveryLifecycleState,
    receivedAt: requireUtcTimestamp(row.received_at, "stored receivedAt"),
  };
}

export class D1DeliveryClaimStore implements DeliveryClaimStore, RecoverableDeliveryClaimStore {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async claim(delivery: DeliveryClaim): Promise<"claimed" | "duplicate"> {
    const { deliveryId, eventName, project, claimedAt } = claimIdentity(delivery);

    const insert = await this.#database
      .prepare(INSERT_CLAIM_SQL)
      .bind(deliveryId, project.repository, project.id, eventName, claimedAt)
      .run();

    requireSuccessfulResult(insert, "delivery claim insert");

    if (insert.meta.changes === 1) return "claimed";
    if (insert.meta.changes !== 0) {
      throw new D1DeliveryClaimError("D1 delivery claim insert returned an unexpected change count");
    }

    const existing = await this.readDelivery(deliveryId);
    if (
      existing.deliveryId !== deliveryId ||
      existing.repository !== project.repository ||
      existing.projectId !== project.id ||
      existing.eventName !== eventName
    ) {
      throw new D1DeliveryClaimError("D1 duplicate delivery identity does not match the authenticated claim");
    }

    return "duplicate";
  }

  async readDelivery(deliveryId: string): Promise<DurableClaimedDelivery> {
    const normalizedDeliveryId = requireOpaque(deliveryId, "deliveryId");
    const existing = await this.#database
      .prepare(READ_DELIVERY_SQL)
      .bind(normalizedDeliveryId)
      .run<ExistingClaimRow>();

    requireSuccessfulResult(existing, "delivery read");
    if (existing.results.length !== 1) {
      throw new D1DeliveryClaimError("D1 delivery identity could not be uniquely proven");
    }
    return durableDelivery(existing.results[0]);
  }

  async markEnqueued(delivery: DeliveryClaim, enqueuedAt: string): Promise<void> {
    const { deliveryId, eventName, project } = claimIdentity(delivery);
    const normalizedEnqueuedAt = requireUtcTimestamp(enqueuedAt, "enqueuedAt");

    const update = await this.#database
      .prepare(MARK_ENQUEUED_SQL)
      .bind(deliveryId, project.repository, project.id, eventName, normalizedEnqueuedAt)
      .run();

    requireSuccessfulResult(update, "delivery enqueue transition");
    if (update.meta.changes !== 1) {
      throw new D1DeliveryClaimError(
        "D1 delivery enqueue transition did not update exactly one RECEIVED delivery",
      );
    }
  }
}
