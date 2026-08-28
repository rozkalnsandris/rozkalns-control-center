import type { ControlDashboardData } from "./control-model.js";
import {
  createLaterDeferral,
  LaterDecisionError,
  laterDecisionStateFingerprint,
} from "./later-decision.js";
import type { LaterDecisionActor, LaterDeferralStore } from "./later-deferral-store.js";

export type LaterActionErrorCode =
  | "INVALID_REQUEST"
  | "DECISION_NOT_FOUND"
  | "ACTION_NOT_ALLOWED"
  | "AUTHORIZATION_STALE_STATE"
  | "RECONCILIATION_FAILED"
  | "PERSISTENCE_CONFLICT"
  | "PERSISTENCE_FAILED";

export class LaterActionError extends Error {
  readonly code: LaterActionErrorCode;

  constructor(code: LaterActionErrorCode) {
    super("Later action failed closed");
    this.name = "LaterActionError";
    this.code = code;
  }
}

export interface LaterActionRequest {
  readonly repository: string;
  readonly projectId: string;
  readonly decisionId: string;
  readonly expectedStateFingerprint: string;
  readonly actor: LaterDecisionActor;
}

export type LaterActionStatus = "DEFERRED" | "REPLAYED" | "REPLACED";

export interface LaterActionResult {
  readonly status: LaterActionStatus;
  readonly repository: string;
  readonly projectId: string;
  readonly decisionId: string;
  readonly stateFingerprint: string;
  readonly observedAt: string;
}

export interface LaterActionDependencies {
  readonly readDashboard: (observedAt: string) => Promise<ControlDashboardData>;
  readonly store: LaterDeferralStore;
  readonly clock?: () => Date;
}

const FINGERPRINT_PATTERN = /^later-v1-[0-9a-f]{16}$/;
const IDENTIFIER_LIMIT = 256;

function fail(code: LaterActionErrorCode): never {
  throw new LaterActionError(code);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_LIMIT ||
    hasControlCharacter(value)
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function observedAt(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("INVALID_REQUEST");
  }
  return value.toISOString();
}

function validateRequest(request: LaterActionRequest): LaterActionRequest {
  if (!request || typeof request !== "object") fail("INVALID_REQUEST");
  return {
    repository: requireIdentifier(request.repository),
    projectId: requireIdentifier(request.projectId),
    decisionId: requireIdentifier(request.decisionId),
    expectedStateFingerprint: requireFingerprint(request.expectedStateFingerprint),
    actor: request.actor,
  };
}

export async function executeLaterAction(
  requestInput: LaterActionRequest,
  dependencies: LaterActionDependencies,
): Promise<LaterActionResult> {
  const request = validateRequest(requestInput);
  const now = observedAt(dependencies.clock ?? (() => new Date()));

  let dashboard: ControlDashboardData;
  try {
    dashboard = await dependencies.readDashboard(now);
  } catch {
    fail("RECONCILIATION_FAILED");
  }

  const project = dashboard.projects.find(
    (candidate) =>
      candidate.enabled &&
      candidate.id === request.projectId &&
      candidate.repository === request.repository,
  );
  if (!project) fail("DECISION_NOT_FOUND");

  const decision = dashboard.decisions.find(
    (candidate) => candidate.id === request.decisionId && candidate.projectId === project.id,
  );
  if (!decision) fail("DECISION_NOT_FOUND");
  if (!decision.allowedActions.includes("LATER")) fail("ACTION_NOT_ALLOWED");

  let stateFingerprint: string;
  try {
    stateFingerprint = laterDecisionStateFingerprint(decision);
  } catch (error) {
    if (error instanceof LaterDecisionError) fail("RECONCILIATION_FAILED");
    throw error;
  }
  if (stateFingerprint !== request.expectedStateFingerprint) {
    fail("AUTHORIZATION_STALE_STATE");
  }

  let evidence;
  try {
    evidence = createLaterDeferral(decision, now);
  } catch (error) {
    if (error instanceof LaterDecisionError && error.code === "ACTION_NOT_ALLOWED") {
      fail("ACTION_NOT_ALLOWED");
    }
    if (error instanceof LaterDecisionError) fail("RECONCILIATION_FAILED");
    throw error;
  }

  try {
    const existing = await dependencies.store.read(evidence.decisionId);
    if (existing === null || existing.stateFingerprint === evidence.stateFingerprint) {
      const claimed = await dependencies.store.claim({ actor: request.actor, evidence });
      if (claimed.kind === "CONFLICT") fail("PERSISTENCE_CONFLICT");
      return {
        status: claimed.kind === "CLAIMED" ? "DEFERRED" : "REPLAYED",
        repository: request.repository,
        projectId: request.projectId,
        decisionId: request.decisionId,
        stateFingerprint: evidence.stateFingerprint,
        observedAt: now,
      };
    }

    const replaced = await dependencies.store.replace({
      expectedStateFingerprint: existing.stateFingerprint,
      claim: { actor: request.actor, evidence },
    });
    if (replaced.kind === "CONFLICT") fail("PERSISTENCE_CONFLICT");
    return {
      status: replaced.kind === "REPLACED" ? "REPLACED" : "REPLAYED",
      repository: request.repository,
      projectId: request.projectId,
      decisionId: request.decisionId,
      stateFingerprint: evidence.stateFingerprint,
      observedAt: now,
    };
  } catch (error) {
    if (error instanceof LaterActionError) throw error;
    fail("PERSISTENCE_FAILED");
  }
}
