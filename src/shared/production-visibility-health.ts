import {
  MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS,
  normalizeProductionVisibility,
  type ProductionDriftState,
  type ProductionHealthState,
  type ProductionRollbackState,
  type ProductionRuntimeState,
  type ProductionVisibilityReadModel,
} from "./production-visibility.js";

export const PRODUCTION_VISIBILITY_HEALTH_CONTRACT_ID =
  "control-phase5-production-visibility-health-v1" as const;

export type ProductionVisibilityHealthStatus =
  | "HEALTHY"
  | "STALE"
  | "DRIFTED"
  | "REJECTED"
  | "NOT_OBSERVED"
  | "UNKNOWN";

export type ProductionVisibilityHealthReasonCode =
  | "NO_OBSERVATION"
  | "STALE_EVIDENCE"
  | "FUTURE_EVIDENCE"
  | "INVALID_EVIDENCE"
  | "IDENTITY_MISMATCH"
  | "PRODUCTION_SHA_DRIFT"
  | "RUNTIME_NOT_HEALTHY"
  | "HEALTH_NOT_PASS"
  | "ROLLBACK_NOT_AVAILABLE"
  | "BLOCKERS_PRESENT";

export interface ProductionVisibilityHealthProjectIdentity {
  readonly id: string;
  readonly repository: string;
  readonly productionAdapter: "rpi5";
}

export interface ProductionVisibilityHealthEvidence {
  readonly projectId: string;
  readonly repository: string;
  readonly mainSha: string;
  readonly productionSha: string;
  readonly deployImpact: ProductionVisibilityReadModel["deployImpact"];
  readonly runtime: ProductionRuntimeState;
  readonly health: ProductionHealthState;
  readonly rollback: ProductionRollbackState;
  readonly blockerCodes: readonly string[];
  readonly observedAt: string;
  readonly drift: ProductionDriftState;
  readonly ageMs: number;
}

export interface ProductionVisibilityHealthReadModel {
  readonly contractId: typeof PRODUCTION_VISIBILITY_HEALTH_CONTRACT_ID;
  readonly projectId: string;
  readonly repository: string;
  readonly status: ProductionVisibilityHealthStatus;
  readonly reasonCodes: readonly ProductionVisibilityHealthReasonCode[];
  readonly evidence: ProductionVisibilityHealthEvidence | null;
  readonly authority: {
    readonly evidenceOnly: true;
    readonly authoritativeForMutation: false;
    readonly grantsDeployAuthority: false;
    readonly grantsRollbackAuthority: false;
    readonly grantsDatabaseOrHostAuthority: false;
  };
}

const VISIBILITY_FIELDS = [
  "projectId",
  "repository",
  "mainSha",
  "productionSha",
  "deployImpact",
  "runtime",
  "health",
  "rollback",
  "blockerCodes",
  "observedAt",
  "productionAdapter",
  "drift",
] as const;

const HEALTH_FIELDS = [
  "contractId",
  "projectId",
  "repository",
  "status",
  "reasonCodes",
  "evidence",
  "authority",
] as const;

const EVIDENCE_FIELDS = [
  "projectId",
  "repository",
  "mainSha",
  "productionSha",
  "deployImpact",
  "runtime",
  "health",
  "rollback",
  "blockerCodes",
  "observedAt",
  "drift",
  "ageMs",
] as const;

const AUTHORITY_FIELDS = [
  "evidenceOnly",
  "authoritativeForMutation",
  "grantsDeployAuthority",
  "grantsRollbackAuthority",
  "grantsDatabaseOrHostAuthority",
] as const;

const HEALTH_STATUSES = new Set<ProductionVisibilityHealthStatus>([
  "HEALTHY",
  "STALE",
  "DRIFTED",
  "REJECTED",
  "NOT_OBSERVED",
  "UNKNOWN",
]);

const REASON_CODES = new Set<ProductionVisibilityHealthReasonCode>([
  "NO_OBSERVATION",
  "STALE_EVIDENCE",
  "FUTURE_EVIDENCE",
  "INVALID_EVIDENCE",
  "IDENTITY_MISMATCH",
  "PRODUCTION_SHA_DRIFT",
  "RUNTIME_NOT_HEALTHY",
  "HEALTH_NOT_PASS",
  "ROLLBACK_NOT_AVAILABLE",
  "BLOCKERS_PRESENT",
]);

const DEPLOY_IMPACTS = new Set(["NO_DEPLOY", "AUTO_DEPLOY_SAFE", "MANUAL_ROLLOUT_REQUIRED", "DB_HOST_APPLY_REQUIRED", "UNKNOWN"]);
const RUNTIME_STATES = new Set(["HEALTHY", "DEGRADED", "UNREACHABLE", "UNKNOWN"]);
const HEALTH_STATES = new Set(["PASS", "FAIL", "UNKNOWN"]);
const ROLLBACK_STATES = new Set(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]);

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(input: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length) return false;
  const allowed = new Set(fields);
  return keys.every((key) => typeof key === "string" && allowed.has(key));
}

function canonicalTimestamp(input: unknown): { readonly value: string; readonly ms: number } | null {
  if (typeof input !== "string") return null;
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) return null;
  return { value: new Date(ms).toISOString(), ms };
}

function normalizeVisibility(input: unknown): ProductionVisibilityReadModel | null {
  if (!isPlainRecord(input) || !hasExactFields(input, VISIBILITY_FIELDS)) return null;
  const observed = canonicalTimestamp(input.observedAt);
  if (!observed) return null;

  try {
    const normalized = normalizeProductionVisibility(
      {
        projectId: input.projectId as string,
        repository: input.repository as string,
        mainSha: input.mainSha as string,
        productionSha: input.productionSha as string,
        deployImpact: input.deployImpact as ProductionVisibilityReadModel["deployImpact"],
        runtime: input.runtime as ProductionRuntimeState,
        health: input.health as ProductionHealthState,
        rollback: input.rollback as ProductionRollbackState,
        blockerCodes: input.blockerCodes as readonly string[],
        observedAt: observed.value,
      },
      observed.value,
    );
    if (
      input.productionAdapter !== normalized.productionAdapter ||
      input.drift !== normalized.drift
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function authority(): ProductionVisibilityHealthReadModel["authority"] {
  return {
    evidenceOnly: true,
    authoritativeForMutation: false,
    grantsDeployAuthority: false,
    grantsRollbackAuthority: false,
    grantsDatabaseOrHostAuthority: false,
  };
}

function receipt(
  project: ProductionVisibilityHealthProjectIdentity,
  status: ProductionVisibilityHealthStatus,
  reasonCodes: readonly ProductionVisibilityHealthReasonCode[],
  evidence: ProductionVisibilityHealthEvidence | null,
): ProductionVisibilityHealthReadModel {
  return {
    contractId: PRODUCTION_VISIBILITY_HEALTH_CONTRACT_ID,
    projectId: project.id,
    repository: project.repository,
    status,
    reasonCodes,
    evidence,
    authority: authority(),
  };
}

export function deriveProductionVisibilityHealth(
  project: ProductionVisibilityHealthProjectIdentity,
  visibilityInput: unknown,
  nowInput: string,
): ProductionVisibilityHealthReadModel {
  if (visibilityInput === null || visibilityInput === undefined) {
    return receipt(project, "NOT_OBSERVED", ["NO_OBSERVATION"], null);
  }

  const now = canonicalTimestamp(nowInput);
  const visibility = normalizeVisibility(visibilityInput);
  if (!now || !visibility) {
    return receipt(project, "REJECTED", ["INVALID_EVIDENCE"], null);
  }
  if (visibility.projectId !== project.id || visibility.repository !== project.repository) {
    return receipt(project, "REJECTED", ["IDENTITY_MISMATCH"], null);
  }

  const observedMs = Date.parse(visibility.observedAt);
  const ageMs = now.ms - observedMs;
  if (ageMs < 0) {
    return receipt(project, "REJECTED", ["FUTURE_EVIDENCE"], null);
  }

  const evidence: ProductionVisibilityHealthEvidence = {
    projectId: visibility.projectId,
    repository: visibility.repository,
    mainSha: visibility.mainSha,
    productionSha: visibility.productionSha,
    deployImpact: visibility.deployImpact,
    runtime: visibility.runtime,
    health: visibility.health,
    rollback: visibility.rollback,
    blockerCodes: [...visibility.blockerCodes],
    observedAt: visibility.observedAt,
    drift: visibility.drift,
    ageMs,
  };

  if (ageMs > MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS) {
    return receipt(project, "STALE", ["STALE_EVIDENCE"], evidence);
  }
  if (visibility.drift === "DRIFTED") {
    return receipt(project, "DRIFTED", ["PRODUCTION_SHA_DRIFT"], evidence);
  }

  const reasons: ProductionVisibilityHealthReasonCode[] = [];
  if (visibility.runtime !== "HEALTHY") reasons.push("RUNTIME_NOT_HEALTHY");
  if (visibility.health !== "PASS") reasons.push("HEALTH_NOT_PASS");
  if (visibility.rollback !== "AVAILABLE") reasons.push("ROLLBACK_NOT_AVAILABLE");
  if (visibility.blockerCodes.length > 0) reasons.push("BLOCKERS_PRESENT");
  if (reasons.length > 0) return receipt(project, "UNKNOWN", reasons, evidence);

  return receipt(project, "HEALTHY", [], evidence);
}

function isStringArray(input: unknown): input is readonly string[] {
  return Array.isArray(input) && input.every((value) => typeof value === "string");
}

function isHealthEvidence(input: unknown): input is ProductionVisibilityHealthEvidence {
  if (!isPlainRecord(input) || !hasExactFields(input, EVIDENCE_FIELDS)) return false;
  return (
    typeof input.projectId === "string" &&
    typeof input.repository === "string" &&
    typeof input.mainSha === "string" &&
    typeof input.productionSha === "string" &&
    typeof input.deployImpact === "string" &&
    DEPLOY_IMPACTS.has(input.deployImpact) &&
    typeof input.runtime === "string" &&
    RUNTIME_STATES.has(input.runtime) &&
    typeof input.health === "string" &&
    HEALTH_STATES.has(input.health) &&
    typeof input.rollback === "string" &&
    ROLLBACK_STATES.has(input.rollback) &&
    isStringArray(input.blockerCodes) &&
    typeof input.observedAt === "string" &&
    (input.drift === "IN_SYNC" || input.drift === "DRIFTED") &&
    Number.isSafeInteger(input.ageMs) &&
    (input.ageMs as number) >= 0
  );
}

function isAuthority(input: unknown): boolean {
  if (!isPlainRecord(input) || !hasExactFields(input, AUTHORITY_FIELDS)) return false;
  return (
    input.evidenceOnly === true &&
    input.authoritativeForMutation === false &&
    input.grantsDeployAuthority === false &&
    input.grantsRollbackAuthority === false &&
    input.grantsDatabaseOrHostAuthority === false
  );
}

export function isProductionVisibilityHealthReadModel(
  input: unknown,
): input is ProductionVisibilityHealthReadModel {
  if (!isPlainRecord(input) || !hasExactFields(input, HEALTH_FIELDS)) return false;
  return (
    input.contractId === PRODUCTION_VISIBILITY_HEALTH_CONTRACT_ID &&
    typeof input.projectId === "string" &&
    typeof input.repository === "string" &&
    typeof input.status === "string" &&
    HEALTH_STATUSES.has(input.status as ProductionVisibilityHealthStatus) &&
    isStringArray(input.reasonCodes) &&
    input.reasonCodes.every((code) =>
      REASON_CODES.has(code as ProductionVisibilityHealthReasonCode),
    ) &&
    (input.evidence === null || isHealthEvidence(input.evidence)) &&
    isAuthority(input.authority)
  );
}
