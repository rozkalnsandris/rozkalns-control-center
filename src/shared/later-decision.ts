import type { DecisionReadModel, MockAction } from "./control-model.js";

export type LaterDecisionErrorCode =
  | "INVALID_INPUT"
  | "ACTION_NOT_ALLOWED"
  | "IDENTITY_MISMATCH";

export class LaterDecisionError extends Error {
  readonly code: LaterDecisionErrorCode;

  constructor(code: LaterDecisionErrorCode) {
    super("Later decision evaluation failed closed");
    this.name = "LaterDecisionError";
    this.code = code;
  }
}

export interface LaterDeferralEvidence {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly projectId: string;
  readonly issueNumber: number | null;
  readonly prNumber: number | null;
  readonly stateFingerprint: string;
  readonly deferredAt: string;
}

export type LaterDeferralEvaluation =
  | {
      readonly kind: "DEFERRED_UNCHANGED";
      readonly stateFingerprint: string;
    }
  | {
      readonly kind: "RELEASE_MATERIAL_CHANGE";
      readonly previousStateFingerprint: string;
      readonly currentStateFingerprint: string;
    };

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^later-v1-[0-9a-f]{16}$/;
const IDENTIFIER_LIMIT = 256;
const REASON_LIMIT = 4096;

const WORKFLOW_STATES = new Set([
  "NEEDS_ANDRIS",
  "WORKING",
  "WAITING",
  "CI_FAILED",
  "MERGE_READY",
  "DONE",
]);
const CI_STATES = new Set(["PASS", "FAIL", "RUNNING", "WAITING"]);
const REVIEW_STATES = new Set(["PASS", "CHANGES_REQUESTED", "PENDING", "NOT_REQUIRED"]);
const DEPLOY_IMPACTS = new Set([
  "NO_DEPLOY",
  "AUTO_DEPLOY_SAFE",
  "MANUAL_ROLLOUT_REQUIRED",
  "DB_HOST_APPLY_REQUIRED",
  "UNKNOWN",
]);
const ACTIONS = new Set<MockAction>(["MERGE", "NEEDS_CHANGES", "LATER", "OPEN_PR"]);

function fail(code: LaterDecisionErrorCode): never {
  throw new LaterDecisionError(code);
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_LIMIT ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireOptionalPositiveInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail("INVALID_INPUT");
  return Number(value);
}

function requireSha(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail("INVALID_INPUT");
  return value;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("INVALID_INPUT");
  return value;
}

function requireEnum(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== "string" || !allowed.has(value)) fail("INVALID_INPUT");
  return value;
}

function normalizedActions(value: unknown): MockAction[] {
  if (!Array.isArray(value)) fail("INVALID_INPUT");
  const actions = value.map((action) => {
    if (typeof action !== "string" || !ACTIONS.has(action as MockAction)) fail("INVALID_INPUT");
    return action as MockAction;
  });
  if (new Set(actions).size !== actions.length) fail("INVALID_INPUT");
  return [...actions].sort();
}

function stableFingerprint(value: string): string {
  let hash = FNV64_OFFSET;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function validateDecision(item: DecisionReadModel): void {
  if (!item || typeof item !== "object") fail("INVALID_INPUT");
  requireIdentifier(item.id);
  requireIdentifier(item.projectId);
  requireEnum(item.workflowState, WORKFLOW_STATES);
  requireOptionalPositiveInteger(item.issueNumber);
  requireOptionalPositiveInteger(item.prNumber);
  requireEnum(item.ci, CI_STATES);
  requireEnum(item.review, REVIEW_STATES);
  requireEnum(item.deployImpact, DEPLOY_IMPACTS);
  if (!Number.isSafeInteger(item.changedFiles) || item.changedFiles < 0) fail("INVALID_INPUT");
  requireSha(item.expectedHeadSha, true);
  requireSha(item.currentHeadSha, true);
  requireSha(item.mainSha, false);
  if (
    typeof item.reason !== "string" ||
    item.reason.length === 0 ||
    item.reason.length > REASON_LIMIT ||
    /[\u0000\u007f]/u.test(item.reason)
  ) {
    fail("INVALID_INPUT");
  }
  normalizedActions(item.allowedActions);
}

function materialState(item: DecisionReadModel): string {
  validateDecision(item);
  return JSON.stringify([
    "later-decision-v1",
    item.id,
    item.projectId,
    item.workflowState,
    item.issueNumber,
    item.prNumber,
    item.ci,
    item.review,
    item.deployImpact,
    item.changedFiles,
    item.expectedHeadSha,
    item.currentHeadSha,
    item.mainSha,
    item.reason,
    normalizedActions(item.allowedActions),
  ]);
}

export function laterDecisionStateFingerprint(item: DecisionReadModel): string {
  return `later-v1-${stableFingerprint(materialState(item))}`;
}

export function createLaterDeferral(
  item: DecisionReadModel,
  deferredAtInput: string,
): LaterDeferralEvidence {
  validateDecision(item);
  if (!item.allowedActions.includes("LATER")) fail("ACTION_NOT_ALLOWED");

  return {
    schemaVersion: 1,
    decisionId: item.id,
    projectId: item.projectId,
    issueNumber: item.issueNumber,
    prNumber: item.prNumber,
    stateFingerprint: laterDecisionStateFingerprint(item),
    deferredAt: requireTimestamp(deferredAtInput),
  };
}

function validateEvidence(evidence: LaterDeferralEvidence): void {
  if (!evidence || typeof evidence !== "object" || evidence.schemaVersion !== 1) {
    fail("INVALID_INPUT");
  }
  requireIdentifier(evidence.decisionId);
  requireIdentifier(evidence.projectId);
  requireOptionalPositiveInteger(evidence.issueNumber);
  requireOptionalPositiveInteger(evidence.prNumber);
  if (
    typeof evidence.stateFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(evidence.stateFingerprint)
  ) {
    fail("INVALID_INPUT");
  }
  requireTimestamp(evidence.deferredAt);
}

/**
 * Evaluate one already-recorded Later deferral against a fresh normalized decision.
 *
 * This pure contract performs no persistence, notification send, GitHub mutation,
 * scheduling or UI action. An unchanged result means only that a future caller may
 * keep suppressing repeated attention for this exact material decision state.
 */
export function evaluateLaterDeferral(
  evidence: LaterDeferralEvidence,
  current: DecisionReadModel,
): LaterDeferralEvaluation {
  validateEvidence(evidence);
  validateDecision(current);

  if (evidence.decisionId !== current.id || evidence.projectId !== current.projectId) {
    fail("IDENTITY_MISMATCH");
  }

  const currentStateFingerprint = laterDecisionStateFingerprint(current);
  if (currentStateFingerprint === evidence.stateFingerprint) {
    return {
      kind: "DEFERRED_UNCHANGED",
      stateFingerprint: currentStateFingerprint,
    };
  }

  return {
    kind: "RELEASE_MATERIAL_CHANGE",
    previousStateFingerprint: evidence.stateFingerprint,
    currentStateFingerprint,
  };
}
