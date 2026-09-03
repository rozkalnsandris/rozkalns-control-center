import type { ControlDashboardData } from "./control-model.js";

export const MAX_DASHBOARD_SNAPSHOT_AGE_MS = 5 * 60_000;
export const MAX_DASHBOARD_CLOCK_SKEW_MS = 30_000;

export type DashboardFreshnessState = "FRESH" | "STALE" | "FUTURE" | "INVALID";

export interface DashboardFreshness {
  readonly state: DashboardFreshnessState;
  readonly field: "generatedAt" | "lastReconciledAt" | null;
  readonly decisionId: string | null;
}

interface TimestampEvidence {
  readonly field: Exclude<DashboardFreshness["field"], null>;
  readonly decisionId: string | null;
  readonly value: string;
}

const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

function parseUtcTimestamp(value: string): number | null {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisText] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText];
  if (parts.some((part) => part === undefined)) return null;

  const [year, month, day, hour, minute, second] = parts.map(Number);
  const millisecond = millisText === undefined ? 0 : Number(millisText);
  const timestamp = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, millisecond);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month! - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second ||
    parsed.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  return timestamp;
}

function classifyTimestamp(value: string, nowMs: number): DashboardFreshnessState {
  const timestamp = parseUtcTimestamp(value);
  if (timestamp === null || !Number.isFinite(nowMs)) return "INVALID";

  const ageMs = nowMs - timestamp;
  if (ageMs < -MAX_DASHBOARD_CLOCK_SKEW_MS) return "FUTURE";
  if (ageMs > MAX_DASHBOARD_SNAPSHOT_AGE_MS) return "STALE";
  return "FRESH";
}

function result(state: DashboardFreshnessState, evidence?: TimestampEvidence): DashboardFreshness {
  return {
    state,
    field: evidence?.field ?? null,
    decisionId: evidence?.decisionId ?? null,
  };
}

/**
 * Classify the complete dashboard evidence used by mutation-capable UI.
 *
 * Five minutes matches the existing production-visibility evidence window. A
 * small 30-second future tolerance absorbs ordinary browser/edge clock skew;
 * anything beyond it fails closed. Exact age/skew thresholds remain fresh.
 */
export function classifyDashboardFreshness(
  dashboard: Pick<ControlDashboardData, "generatedAt" | "decisions">,
  nowMs = Date.now(),
): DashboardFreshness {
  const evidence: TimestampEvidence[] = [
    { field: "generatedAt", decisionId: null, value: dashboard.generatedAt },
    ...dashboard.decisions.map((decision) => ({
      field: "lastReconciledAt" as const,
      decisionId: decision.id,
      value: decision.lastReconciledAt,
    })),
  ];
  const classified = evidence.map((item) => ({ item, state: classifyTimestamp(item.value, nowMs) }));

  for (const state of ["INVALID", "FUTURE", "STALE"] as const) {
    const match = classified.find((item) => item.state === state);
    if (match) return result(state, match.item);
  }
  return result("FRESH");
}
