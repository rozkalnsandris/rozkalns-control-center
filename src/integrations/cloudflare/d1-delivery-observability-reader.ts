import type { DeliveryLifecycleState } from "../../shared/reconciliation-durability.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import {
  WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT,
  WEBHOOK_DELIVERY_STALE_AFTER_SECONDS,
  type WebhookDeliveryDiagnostic,
  type WebhookDeliveryDiagnosticDisposition,
  type WebhookDeliveryObservabilityReader,
  type WebhookDeliveryObservabilitySnapshot,
  type WebhookDeliveryObservabilityStatus,
  type WebhookDeliveryStateCounts,
} from "../../shared/webhook-delivery-observability.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

export {
  WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT,
  WEBHOOK_DELIVERY_STALE_AFTER_SECONDS,
  type WebhookDeliveryDiagnostic,
  type WebhookDeliveryDiagnosticDisposition,
  type WebhookDeliveryObservabilityReader,
  type WebhookDeliveryObservabilitySnapshot,
  type WebhookDeliveryObservabilityStatus,
  type WebhookDeliveryStateCounts,
};

const deliveryStates: readonly DeliveryLifecycleState[] = [
  "RECEIVED",
  "ENQUEUED",
  "PROCESSING",
  "RETRY_PENDING",
  "SUCCEEDED",
  "DEAD_LETTERED",
];
const deliveryStateSet = new Set<DeliveryLifecycleState>(deliveryStates);
const nonTerminalStates = new Set<DeliveryLifecycleState>([
  "RECEIVED",
  "ENQUEUED",
  "PROCESSING",
  "RETRY_PENDING",
]);
const opaqueIdentifierPattern = /^[A-Za-z0-9._:/+-]{1,200}$/;
const stableErrorCodePattern = /^[A-Z][A-Z0-9_]{0,79}$/;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const COUNT_BY_STATE_SQL = `
SELECT state, COUNT(*) AS count
FROM webhook_deliveries
GROUP BY state
ORDER BY state ASC
`.trim();

const READ_DIAGNOSTICS_SQL = `
SELECT
  delivery_id,
  repository,
  project_id,
  event_name,
  state,
  attempt_count,
  received_at,
  updated_at,
  last_error_code
FROM webhook_deliveries
WHERE state <> 'SUCCEEDED'
ORDER BY updated_at ASC, delivery_id ASC
LIMIT ?1
`.trim();

interface DeliveryStateCountRow {
  readonly state: string;
  readonly count: number;
}

interface DeliveryDiagnosticRow {
  readonly delivery_id: string;
  readonly repository: string;
  readonly project_id: string;
  readonly event_name: string;
  readonly state: string;
  readonly attempt_count: number;
  readonly received_at: string;
  readonly updated_at: string;
  readonly last_error_code: string | null;
}

export class D1DeliveryObservabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1DeliveryObservabilityError";
  }
}

function requireSuccessfulResult<Row>(result: D1RunResultLike<Row>, operation: string): readonly Row[] {
  if (result.success !== true) {
    throw new D1DeliveryObservabilityError(`D1 ${operation} did not report success`);
  }
  return result.results;
}

function requireUtcTimestamp(value: string, field: string): string {
  if (!utcTimestampPattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new D1DeliveryObservabilityError(`${field} must be a UTC ISO timestamp`);
  }
  return value;
}

function requireOpaque(value: string, field: string): string {
  if (!opaqueIdentifierPattern.test(value)) {
    throw new D1DeliveryObservabilityError(`${field} is malformed`);
  }
  return value;
}

function requireAttemptCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new D1DeliveryObservabilityError("D1 delivery attempt count is invalid");
  }
  return value;
}

function requireCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new D1DeliveryObservabilityError("D1 delivery state count is invalid");
  }
  return value;
}

function requireState(value: string): DeliveryLifecycleState {
  if (!deliveryStateSet.has(value as DeliveryLifecycleState)) {
    throw new D1DeliveryObservabilityError(`Unsupported D1 delivery state: ${value}`);
  }
  return value as DeliveryLifecycleState;
}

function requireNullableErrorCode(value: string | null): string | null {
  if (value === null) return null;
  if (!stableErrorCodePattern.test(value)) {
    throw new D1DeliveryObservabilityError("D1 delivery last error code is invalid");
  }
  return value;
}

function emptyCounts(): Record<DeliveryLifecycleState, number> {
  return {
    RECEIVED: 0,
    ENQUEUED: 0,
    PROCESSING: 0,
    RETRY_PENDING: 0,
    SUCCEEDED: 0,
    DEAD_LETTERED: 0,
  };
}

function parseCounts(rows: readonly DeliveryStateCountRow[]): WebhookDeliveryStateCounts {
  const counts = emptyCounts();
  const seen = new Set<DeliveryLifecycleState>();

  for (const row of rows) {
    const state = requireState(row.state);
    if (seen.has(state)) {
      throw new D1DeliveryObservabilityError(`Duplicate D1 delivery state aggregate: ${state}`);
    }
    seen.add(state);
    counts[state] = requireCount(row.count);
  }

  return counts;
}

function diagnosticFromRow(
  row: DeliveryDiagnosticRow,
  observedAtMs: number,
): WebhookDeliveryDiagnostic {
  const state = requireState(row.state);
  if (state === "SUCCEEDED") {
    throw new D1DeliveryObservabilityError("Succeeded delivery leaked into diagnostic query");
  }

  const project = requireManagedProjectPolicy(row.repository);
  if (row.project_id !== project.id) {
    throw new D1DeliveryObservabilityError("D1 delivery project does not match repository policy");
  }

  const receivedAt = requireUtcTimestamp(row.received_at, "stored receivedAt");
  const updatedAt = requireUtcTimestamp(row.updated_at, "stored updatedAt");
  const receivedAtMs = Date.parse(receivedAt);
  const updatedAtMs = Date.parse(updatedAt);
  if (receivedAtMs > updatedAtMs || updatedAtMs > observedAtMs) {
    throw new D1DeliveryObservabilityError("D1 delivery timestamps are temporally inconsistent");
  }

  const disposition: WebhookDeliveryDiagnosticDisposition =
    state === "DEAD_LETTERED"
      ? "DEAD_LETTERED"
      : observedAtMs - updatedAtMs >= WEBHOOK_DELIVERY_STALE_AFTER_SECONDS * 1000
        ? "STALE"
        : "ACTIVE";

  return {
    deliveryId: requireOpaque(row.delivery_id, "stored deliveryId"),
    repository: project.repository,
    projectId: project.id,
    eventName: requireOpaque(row.event_name, "stored eventName"),
    state,
    attemptCount: requireAttemptCount(row.attempt_count),
    receivedAt,
    updatedAt,
    lastErrorCode: requireNullableErrorCode(row.last_error_code),
    disposition,
  };
}

export class D1WebhookDeliveryObservabilityReader implements WebhookDeliveryObservabilityReader {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async readSnapshot(observedAt: string): Promise<WebhookDeliveryObservabilitySnapshot> {
    const normalizedObservedAt = requireUtcTimestamp(observedAt, "observedAt");
    const observedAtMs = Date.parse(normalizedObservedAt);

    const countResult = await this.#database
      .prepare(COUNT_BY_STATE_SQL)
      .run<DeliveryStateCountRow>();
    const counts = parseCounts(requireSuccessfulResult(countResult, "delivery state aggregation"));

    const diagnosticResult = await this.#database
      .prepare(READ_DIAGNOSTICS_SQL)
      .bind(WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT + 1)
      .run<DeliveryDiagnosticRow>();
    const diagnosticRows = requireSuccessfulResult(diagnosticResult, "delivery diagnostic read");
    const diagnosticsTruncated = diagnosticRows.length > WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT;
    const diagnostics = diagnosticRows
      .slice(0, WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT)
      .map((row) => diagnosticFromRow(row, observedAtMs));

    const nonTerminalCount = [...nonTerminalStates].reduce((sum, state) => sum + counts[state], 0);
    const deadLetteredCount = counts.DEAD_LETTERED;
    const staleEvidenceCount = diagnostics.filter((entry) => entry.disposition === "STALE").length;
    const totalDeliveries = deliveryStates.reduce((sum, state) => sum + counts[state], 0);
    const status: WebhookDeliveryObservabilityStatus =
      deadLetteredCount > 0 || staleEvidenceCount > 0
        ? "ATTENTION"
        : nonTerminalCount > 0
          ? "ACTIVE"
          : "HEALTHY";

    return {
      observedAt: normalizedObservedAt,
      status,
      staleAfterSeconds: WEBHOOK_DELIVERY_STALE_AFTER_SECONDS,
      totalDeliveries,
      nonTerminalCount,
      deadLetteredCount,
      staleEvidenceCount,
      counts,
      diagnostics,
      diagnosticsTruncated,
    };
  }
}
