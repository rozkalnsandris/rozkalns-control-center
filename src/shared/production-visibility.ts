import type { DeployImpact } from "./control-model.js";
import { requireManagedProjectPolicy } from "./project-policy.js";

export type ProductionRuntimeState = "HEALTHY" | "DEGRADED" | "UNREACHABLE" | "UNKNOWN";
export type ProductionHealthState = "PASS" | "FAIL" | "UNKNOWN";
export type ProductionRollbackState = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
export type ProductionDriftState = "IN_SYNC" | "DRIFTED";

export interface ProductionVisibilityEvidence {
  readonly projectId: string;
  readonly repository: string;
  readonly mainSha: string;
  readonly productionSha: string;
  readonly deployImpact: DeployImpact;
  readonly runtime: ProductionRuntimeState;
  readonly health: ProductionHealthState;
  readonly rollback: ProductionRollbackState;
  readonly blockerCodes: readonly string[];
  readonly observedAt: string;
}

export interface ProductionVisibilityReadModel extends ProductionVisibilityEvidence {
  readonly productionAdapter: "rpi5";
  readonly drift: ProductionDriftState;
}

export type ProductionVisibilityErrorCode =
  | "INVALID_INPUT"
  | "REPOSITORY_NOT_ALLOWED"
  | "PRODUCTION_ADAPTER_UNSUPPORTED"
  | "IDENTITY_MISMATCH"
  | "STALE_EVIDENCE"
  | "CONTRADICTORY_EVIDENCE"
  | "TOO_MANY_BLOCKERS"
  | "DUPLICATE_BLOCKER";

export class ProductionVisibilityError extends Error {
  readonly code: ProductionVisibilityErrorCode;

  constructor(code: ProductionVisibilityErrorCode) {
    super("Production visibility evidence failed closed");
    this.name = "ProductionVisibilityError";
    this.code = code;
  }
}

export const MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS = 5 * 60_000;
export const MAX_PRODUCTION_VISIBILITY_BLOCKERS = 20;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const BLOCKER_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,127}$/;
const DEPLOY_IMPACTS = new Set<DeployImpact>([
  "NO_DEPLOY",
  "AUTO_DEPLOY_SAFE",
  "MANUAL_ROLLOUT_REQUIRED",
  "DB_HOST_APPLY_REQUIRED",
  "UNKNOWN",
]);
const RUNTIME_STATES = new Set<ProductionRuntimeState>([
  "HEALTHY",
  "DEGRADED",
  "UNREACHABLE",
  "UNKNOWN",
]);
const HEALTH_STATES = new Set<ProductionHealthState>(["PASS", "FAIL", "UNKNOWN"]);
const ROLLBACK_STATES = new Set<ProductionRollbackState>([
  "AVAILABLE",
  "UNAVAILABLE",
  "UNKNOWN",
]);

function fail(code: ProductionVisibilityErrorCode): never {
  throw new ProductionVisibilityError(code);
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) fail("INVALID_INPUT");
  return value;
}

function requireSha(value: unknown): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail("INVALID_INPUT");
  return value;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("INVALID_INPUT");
  }
  return value;
}

function validateBlockers(blockerCodes: readonly string[]): readonly string[] {
  if (!Array.isArray(blockerCodes)) fail("INVALID_INPUT");
  if (blockerCodes.length > MAX_PRODUCTION_VISIBILITY_BLOCKERS) fail("TOO_MANY_BLOCKERS");

  const seen = new Set<string>();
  const validated: string[] = [];
  for (const blockerCode of blockerCodes) {
    if (typeof blockerCode !== "string" || !BLOCKER_CODE_PATTERN.test(blockerCode)) {
      fail("INVALID_INPUT");
    }
    if (seen.has(blockerCode)) fail("DUPLICATE_BLOCKER");
    seen.add(blockerCode);
    validated.push(blockerCode);
  }
  return validated;
}

/**
 * Normalize bounded, sanitized production evidence for the Control read model.
 *
 * This function performs no network, host, database, queue, deployment or rollback
 * operation. Callers must obtain production evidence through a separately reviewed
 * read-only adapter and must not treat this projection as mutation authorization.
 */
export function normalizeProductionVisibility(
  evidence: ProductionVisibilityEvidence,
  nowInput: string,
): ProductionVisibilityReadModel {
  if (!evidence || typeof evidence !== "object") fail("INVALID_INPUT");

  const projectId = requireIdentifier(evidence.projectId);
  const repository = requireIdentifier(evidence.repository.replace("/", ":")).replace(":", "/");
  const mainSha = requireSha(evidence.mainSha);
  const productionSha = requireSha(evidence.productionSha);
  const observedAt = requireTimestamp(evidence.observedAt);
  const now = requireTimestamp(nowInput);

  if (!DEPLOY_IMPACTS.has(evidence.deployImpact)) fail("INVALID_INPUT");
  if (!RUNTIME_STATES.has(evidence.runtime)) fail("INVALID_INPUT");
  if (!HEALTH_STATES.has(evidence.health)) fail("INVALID_INPUT");
  if (!ROLLBACK_STATES.has(evidence.rollback)) fail("INVALID_INPUT");

  let policy;
  try {
    policy = requireManagedProjectPolicy(repository);
  } catch {
    fail("REPOSITORY_NOT_ALLOWED");
  }
  if (policy.id !== projectId || policy.repository !== repository) fail("IDENTITY_MISMATCH");
  if (policy.productionAdapter !== "rpi5") fail("PRODUCTION_ADAPTER_UNSUPPORTED");

  const age = Date.parse(now) - Date.parse(observedAt);
  if (age < 0 || age > MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS) fail("STALE_EVIDENCE");

  if (evidence.runtime === "UNREACHABLE" && evidence.health === "PASS") {
    fail("CONTRADICTORY_EVIDENCE");
  }

  const blockerCodes = validateBlockers(evidence.blockerCodes);

  return {
    projectId,
    repository: policy.repository,
    mainSha,
    productionSha,
    deployImpact: evidence.deployImpact,
    runtime: evidence.runtime,
    health: evidence.health,
    rollback: evidence.rollback,
    blockerCodes,
    observedAt,
    productionAdapter: "rpi5",
    drift: mainSha === productionSha ? "IN_SYNC" : "DRIFTED",
  };
}
