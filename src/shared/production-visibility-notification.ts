import { sanitizeNotificationText } from "./notification-transition.js";
import type {
  ProductionVisibilityHealthReadModel,
  ProductionVisibilityHealthStatus,
} from "./production-visibility-health.js";

export const PRODUCTION_VISIBILITY_NOTIFICATION_CONTRACT_ID =
  "control-phase5-production-visibility-notification-v1" as const;
export const PRODUCTION_VISIBILITY_NOTIFICATION_DEEP_LINK_PATH = "/#projects-title" as const;

export type ProductionVisibilityNotificationSignal =
  | "STALE"
  | "DRIFTED"
  | "REJECTED"
  | "RECOVERED";

export type ProductionVisibilityNotificationNoSignalReason =
  | "LOW_SIGNAL"
  | "UNCHANGED"
  | "MISSING_CURRENT_EVIDENCE"
  | "IDENTITY_MISMATCH";

export interface ProductionVisibilityNotificationDiagnostics {
  readonly mainSha: string | null;
  readonly productionSha: string | null;
  readonly observedAt: string | null;
  readonly ageSeconds: number | null;
  readonly reasonCodes: readonly string[];
}

export interface ProductionVisibilityNotificationCandidate {
  readonly schemaVersion: 1;
  readonly contractId: typeof PRODUCTION_VISIBILITY_NOTIFICATION_CONTRACT_ID;
  readonly signal: ProductionVisibilityNotificationSignal;
  readonly transitionId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly reference: string;
  readonly title: string;
  readonly body: string;
  readonly status: ProductionVisibilityHealthStatus;
  readonly previousStatus: ProductionVisibilityHealthStatus | null;
  readonly diagnostics: ProductionVisibilityNotificationDiagnostics;
  readonly deepLinkPath: typeof PRODUCTION_VISIBILITY_NOTIFICATION_DEEP_LINK_PATH;
}

export type ProductionVisibilityNotificationTransitionResult =
  | {
      readonly kind: "NO_SIGNAL";
      readonly reason: ProductionVisibilityNotificationNoSignalReason;
    }
  | {
      readonly kind: "NEW_TRANSITION";
      readonly candidate: ProductionVisibilityNotificationCandidate;
    };

const ALERT_STATUSES = new Set<ProductionVisibilityHealthStatus>([
  "STALE",
  "DRIFTED",
  "REJECTED",
]);
const PROJECT_LIMIT = 128;
const REPOSITORY_LIMIT = 201;
const REASON_LIMIT = 128;
const REFERENCE_LIMIT = 201;
const TITLE_LIMIT = 160;
const BODY_LIMIT = 280;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;

function alertSignalForStatus(
  status: ProductionVisibilityHealthStatus,
): Exclude<ProductionVisibilityNotificationSignal, "RECOVERED"> | null {
  if (status === "STALE" || status === "DRIFTED" || status === "REJECTED") return status;
  return null;
}

function stableFingerprint(value: string): string {
  let hash = FNV64_OFFSET;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function safeSha(value: string | undefined): string | null {
  return value !== undefined && SHA_PATTERN.test(value) ? value : null;
}

function canonicalTimestamp(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? value : null;
}

function diagnosticsForHealth(
  current: ProductionVisibilityHealthReadModel,
): ProductionVisibilityNotificationDiagnostics {
  const evidence = current.evidence;
  return {
    mainSha: safeSha(evidence?.mainSha),
    productionSha: safeSha(evidence?.productionSha),
    observedAt: canonicalTimestamp(evidence?.observedAt),
    ageSeconds:
      evidence && Number.isSafeInteger(evidence.ageMs) && evidence.ageMs >= 0
        ? Math.floor(evidence.ageMs / 1000)
        : null,
    reasonCodes: current.reasonCodes
      .slice(0, 8)
      .map((code) => sanitizeNotificationText(code, REASON_LIMIT))
      .filter((code) => code.length > 0),
  };
}

function shortSha(sha: string | null): string {
  return sha === null ? "unknown" : sha.slice(0, 7);
}

function freshnessLabel(diagnostics: ProductionVisibilityNotificationDiagnostics): string {
  return diagnostics.ageSeconds === null ? "freshness unknown" : `age ${diagnostics.ageSeconds}s`;
}

function notificationBody(
  current: ProductionVisibilityHealthReadModel,
  diagnostics: ProductionVisibilityNotificationDiagnostics,
  signal: ProductionVisibilityNotificationSignal,
): string {
  const prefix =
    signal === "RECOVERED"
      ? "Production visibility recovered"
      : `Production visibility ${current.status.toLowerCase()}`;
  const state = `main ${shortSha(diagnostics.mainSha)} · production ${shortSha(diagnostics.productionSha)} · ${freshnessLabel(diagnostics)}`;
  const reasons =
    diagnostics.reasonCodes.length > 0
      ? ` · reasons ${diagnostics.reasonCodes.join(", ")}`
      : "";
  return sanitizeNotificationText(`${prefix} · ${state}${reasons}`, BODY_LIMIT);
}

function transitionMaterial(
  previous: ProductionVisibilityHealthReadModel | null,
  current: ProductionVisibilityHealthReadModel,
  signal: ProductionVisibilityNotificationSignal,
  diagnostics: ProductionVisibilityNotificationDiagnostics,
): string {
  return JSON.stringify([
    PRODUCTION_VISIBILITY_NOTIFICATION_CONTRACT_ID,
    signal,
    sanitizeNotificationText(current.projectId, PROJECT_LIMIT),
    sanitizeNotificationText(current.repository, REPOSITORY_LIMIT),
    previous?.status ?? null,
    current.status,
    diagnostics.mainSha,
    diagnostics.productionSha,
    diagnostics.observedAt,
    diagnostics.reasonCodes,
  ]);
}

export function productionVisibilityNotificationTransitionId(
  previous: ProductionVisibilityHealthReadModel | null,
  current: ProductionVisibilityHealthReadModel,
  signal: ProductionVisibilityNotificationSignal,
): string {
  const diagnostics = diagnosticsForHealth(current);
  return `production-visibility-v1-${signal.toLowerCase()}-${stableFingerprint(
    transitionMaterial(previous, current, signal, diagnostics),
  )}`;
}

export function productionVisibilityNotificationCandidate(
  previous: ProductionVisibilityHealthReadModel | null,
  current: ProductionVisibilityHealthReadModel,
  signal: ProductionVisibilityNotificationSignal,
): ProductionVisibilityNotificationCandidate {
  const projectId = sanitizeNotificationText(current.projectId, PROJECT_LIMIT);
  const repository = sanitizeNotificationText(current.repository, REPOSITORY_LIMIT);
  const diagnostics = diagnosticsForHealth(current);
  const reference = sanitizeNotificationText(
    repository || projectId || "Production visibility",
    REFERENCE_LIMIT,
  );
  const title = sanitizeNotificationText(
    `${projectId || "Project"} · ${
      signal === "RECOVERED"
        ? "production visibility recovered"
        : `production visibility ${current.status.toLowerCase()}`
    }`,
    TITLE_LIMIT,
  );

  return {
    schemaVersion: 1,
    contractId: PRODUCTION_VISIBILITY_NOTIFICATION_CONTRACT_ID,
    signal,
    transitionId: productionVisibilityNotificationTransitionId(previous, current, signal),
    projectId,
    repository,
    reference,
    title,
    body: notificationBody(current, diagnostics, signal),
    status: current.status,
    previousStatus: previous?.status ?? null,
    diagnostics,
    deepLinkPath: PRODUCTION_VISIBILITY_NOTIFICATION_DEEP_LINK_PATH,
  };
}

export function evaluateProductionVisibilityNotificationTransition(
  previous: ProductionVisibilityHealthReadModel | null,
  current: ProductionVisibilityHealthReadModel | null,
): ProductionVisibilityNotificationTransitionResult {
  if (current === null) {
    return { kind: "NO_SIGNAL", reason: "MISSING_CURRENT_EVIDENCE" };
  }

  if (
    previous !== null &&
    (previous.projectId !== current.projectId || previous.repository !== current.repository)
  ) {
    return { kind: "NO_SIGNAL", reason: "IDENTITY_MISMATCH" };
  }

  const alertSignal = alertSignalForStatus(current.status);
  if (alertSignal !== null) {
    if (previous?.status === current.status) {
      return { kind: "NO_SIGNAL", reason: "UNCHANGED" };
    }
    return {
      kind: "NEW_TRANSITION",
      candidate: productionVisibilityNotificationCandidate(previous, current, alertSignal),
    };
  }

  if (
    current.status === "HEALTHY" &&
    previous !== null &&
    ALERT_STATUSES.has(previous.status)
  ) {
    return {
      kind: "NEW_TRANSITION",
      candidate: productionVisibilityNotificationCandidate(previous, current, "RECOVERED"),
    };
  }

  return { kind: "NO_SIGNAL", reason: "LOW_SIGNAL" };
}
