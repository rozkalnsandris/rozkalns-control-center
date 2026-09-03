import type { DeliveryLifecycleState } from "./reconciliation-durability.js";
import {
  MAX_DASHBOARD_CLOCK_SKEW_MS,
  MAX_DASHBOARD_SNAPSHOT_AGE_MS,
} from "./dashboard-freshness.js";

export const WEBHOOK_DELIVERY_STALE_AFTER_SECONDS = 15 * 60;
export const WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT = 50;

export type WebhookDeliveryObservabilityStatus = "HEALTHY" | "ACTIVE" | "ATTENTION";
export type WebhookDeliveryDiagnosticDisposition = "ACTIVE" | "STALE" | "DEAD_LETTERED";
export type WebhookDeliveryStateCounts = Readonly<Record<DeliveryLifecycleState, number>>;
export type WebhookDeliveryObservationFreshness = "FRESH" | "STALE" | "FUTURE" | "INVALID";

export interface WebhookDeliveryDiagnostic {
  readonly deliveryId: string;
  readonly repository: string;
  readonly projectId: string;
  readonly eventName: string;
  readonly state: Exclude<DeliveryLifecycleState, "SUCCEEDED">;
  readonly attemptCount: number;
  readonly receivedAt: string;
  readonly updatedAt: string;
  readonly lastErrorCode: string | null;
  readonly disposition: WebhookDeliveryDiagnosticDisposition;
}

export interface WebhookDeliveryObservabilitySnapshot {
  readonly observedAt: string;
  readonly status: WebhookDeliveryObservabilityStatus;
  readonly staleAfterSeconds: number;
  readonly totalDeliveries: number;
  readonly nonTerminalCount: number;
  readonly deadLetteredCount: number;
  readonly staleEvidenceCount: number;
  readonly counts: WebhookDeliveryStateCounts;
  readonly diagnostics: readonly WebhookDeliveryDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

export interface WebhookDeliveryObservabilityReader {
  readSnapshot(observedAt: string): Promise<WebhookDeliveryObservabilitySnapshot>;
}

const DELIVERY_STATES = [
  "RECEIVED",
  "ENQUEUED",
  "PROCESSING",
  "RETRY_PENDING",
  "SUCCEEDED",
  "DEAD_LETTERED",
] as const satisfies readonly DeliveryLifecycleState[];
const NON_TERMINAL_STATES = [
  "RECEIVED",
  "ENQUEUED",
  "PROCESSING",
  "RETRY_PENDING",
] as const satisfies readonly DeliveryLifecycleState[];
const DIAGNOSTIC_STATES = new Set<DeliveryLifecycleState>([
  ...NON_TERMINAL_STATES,
  "DEAD_LETTERED",
]);
const STATUS_VALUES = new Set<WebhookDeliveryObservabilityStatus>(["HEALTHY", "ACTIVE", "ATTENTION"]);
const DISPOSITION_VALUES = new Set<WebhookDeliveryDiagnosticDisposition>(["ACTIVE", "STALE", "DEAD_LETTERED"]);
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const OPAQUE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/+-]{1,200}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function utcTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  if (value !== normalized && value !== normalized.replace(".000Z", "Z")) return null;
  return timestamp;
}

function isStateCounts(value: unknown): value is WebhookDeliveryStateCounts {
  if (!isRecord(value) || Object.keys(value).length !== DELIVERY_STATES.length) return false;
  return DELIVERY_STATES.every((state) => isCount(value[state]));
}

function isDiagnostic(
  value: unknown,
  observedAtMs: number,
): value is WebhookDeliveryDiagnostic {
  if (!isRecord(value)) return false;
  if (
    typeof value.deliveryId !== "string" || !OPAQUE_IDENTIFIER_PATTERN.test(value.deliveryId) ||
    typeof value.repository !== "string" || !REPOSITORY_PATTERN.test(value.repository) ||
    typeof value.projectId !== "string" || !OPAQUE_IDENTIFIER_PATTERN.test(value.projectId) ||
    typeof value.eventName !== "string" || !OPAQUE_IDENTIFIER_PATTERN.test(value.eventName) ||
    typeof value.state !== "string" || !DIAGNOSTIC_STATES.has(value.state as DeliveryLifecycleState) ||
    !isCount(value.attemptCount) ||
    typeof value.disposition !== "string" ||
    !DISPOSITION_VALUES.has(value.disposition as WebhookDeliveryDiagnosticDisposition) ||
    (value.lastErrorCode !== null &&
      (typeof value.lastErrorCode !== "string" || !STABLE_ERROR_CODE_PATTERN.test(value.lastErrorCode)))
  ) {
    return false;
  }

  const receivedAtMs = utcTimestamp(value.receivedAt);
  const updatedAtMs = utcTimestamp(value.updatedAt);
  if (
    receivedAtMs === null ||
    updatedAtMs === null ||
    receivedAtMs > updatedAtMs ||
    updatedAtMs > observedAtMs
  ) {
    return false;
  }

  const expectedDisposition: WebhookDeliveryDiagnosticDisposition =
    value.state === "DEAD_LETTERED"
      ? "DEAD_LETTERED"
      : observedAtMs - updatedAtMs >= WEBHOOK_DELIVERY_STALE_AFTER_SECONDS * 1000
        ? "STALE"
        : "ACTIVE";
  return value.disposition === expectedDisposition;
}

/** Validate the complete public, sanitized delivery-observability contract. */
export function isWebhookDeliveryObservabilitySnapshot(
  value: unknown,
): value is WebhookDeliveryObservabilitySnapshot {
  if (!isRecord(value)) return false;
  const observedAtMs = utcTimestamp(value.observedAt);
  if (
    observedAtMs === null ||
    typeof value.status !== "string" ||
    !STATUS_VALUES.has(value.status as WebhookDeliveryObservabilityStatus) ||
    value.staleAfterSeconds !== WEBHOOK_DELIVERY_STALE_AFTER_SECONDS ||
    !isCount(value.totalDeliveries) ||
    !isCount(value.nonTerminalCount) ||
    !isCount(value.deadLetteredCount) ||
    !isCount(value.staleEvidenceCount) ||
    !isStateCounts(value.counts) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT ||
    typeof value.diagnosticsTruncated !== "boolean" ||
    (value.diagnosticsTruncated && value.diagnostics.length !== WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT) ||
    !value.diagnostics.every((diagnostic) => isDiagnostic(diagnostic, observedAtMs))
  ) {
    return false;
  }

  const counts = value.counts;
  const totalDeliveries = DELIVERY_STATES.reduce((sum, state) => sum + counts[state], 0);
  const nonTerminalCount = NON_TERMINAL_STATES.reduce((sum, state) => sum + counts[state], 0);
  const staleEvidenceCount = value.diagnostics.filter((entry) => entry.disposition === "STALE").length;
  const expectedStatus: WebhookDeliveryObservabilityStatus =
    counts.DEAD_LETTERED > 0 || staleEvidenceCount > 0
      ? "ATTENTION"
      : nonTerminalCount > 0
        ? "ACTIVE"
        : "HEALTHY";
  if (
    value.totalDeliveries !== totalDeliveries ||
    value.nonTerminalCount !== nonTerminalCount ||
    value.deadLetteredCount !== counts.DEAD_LETTERED ||
    value.staleEvidenceCount !== staleEvidenceCount ||
    value.status !== expectedStatus
  ) {
    return false;
  }

  const displayedByState = Object.fromEntries(DELIVERY_STATES.map((state) => [state, 0])) as Record<DeliveryLifecycleState, number>;
  for (const diagnostic of value.diagnostics) displayedByState[diagnostic.state] += 1;
  return DELIVERY_STATES.every((state) => displayedByState[state] <= counts[state]);
}

export function classifyWebhookDeliveryObservation(
  observedAt: string,
  nowMs = Date.now(),
): WebhookDeliveryObservationFreshness {
  const observedAtMs = utcTimestamp(observedAt);
  if (observedAtMs === null || !Number.isFinite(nowMs)) return "INVALID";
  const ageMs = nowMs - observedAtMs;
  if (ageMs < -MAX_DASHBOARD_CLOCK_SKEW_MS) return "FUTURE";
  if (ageMs > MAX_DASHBOARD_SNAPSHOT_AGE_MS) return "STALE";
  return "FRESH";
}
