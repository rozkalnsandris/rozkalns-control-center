import {
  AuthoritativeReconciliationError,
  reconcileAuthoritativePullRequestDecision,
  type BranchPolicyEvidenceReader,
} from "./authoritative-reconciliation.js";
import type { SourceControlReadProvider } from "./source-control-read.js";
import { requireManagedProjectPolicy } from "./project-policy.js";
import {
  GitHubPullRequestReviewWriteError,
  type GitHubPullRequestReviewWriter,
  type GitHubRequestChangesWriteResult,
} from "../integrations/github/pull-request-review-write.js";

export const NEEDS_CHANGES_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
export const NEEDS_CHANGES_ACTOR_MAX_BYTES = 512;

export type NeedsChangesDecisionFailureCode =
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "POLICY_EVIDENCE_INCOMPLETE"
  | "AUTHORIZATION_STALE_HEAD"
  | "AUTHORIZATION_STALE_BASE"
  | "DECISION_NOT_READY"
  | "RECONCILIATION_FAILED"
  | "WRITE_REJECTED"
  | "WRITE_OUTCOME_UNKNOWN"
  | "AUDIT_FINALIZATION_FAILED";

const failureMessages: Readonly<Record<NeedsChangesDecisionFailureCode, string>> = {
  INVALID_REQUEST: "Needs changes decision request failed validation",
  IDEMPOTENCY_CONFLICT: "Needs changes decision request id conflicts with an earlier request",
  IDEMPOTENCY_IN_PROGRESS: "Needs changes decision request is already in progress",
  POLICY_EVIDENCE_INCOMPLETE: "Needs changes decision requires complete live policy evidence",
  AUTHORIZATION_STALE_HEAD: "Needs changes decision expected head no longer matches live GitHub state",
  AUTHORIZATION_STALE_BASE: "Needs changes decision expected base no longer matches live GitHub state",
  DECISION_NOT_READY: "Needs changes decision is not eligible under the fresh authoritative decision state",
  RECONCILIATION_FAILED: "Needs changes decision authoritative reconciliation failed",
  WRITE_REJECTED: "Needs changes review write was rejected",
  WRITE_OUTCOME_UNKNOWN: "Needs changes review write outcome is unknown",
  AUDIT_FINALIZATION_FAILED: "Needs changes decision audit finalization failed",
};

export class NeedsChangesDecisionError extends Error {
  readonly code: NeedsChangesDecisionFailureCode;
  readonly mutationAttempted: boolean;

  constructor(code: NeedsChangesDecisionFailureCode, mutationAttempted = false) {
    super(failureMessages[code]);
    this.name = "NeedsChangesDecisionError";
    this.code = code;
    this.mutationAttempted = mutationAttempted;
  }
}

export interface NeedsChangesActor {
  readonly subject: string;
  readonly email: string | null;
}

export interface NeedsChangesDecisionRequest {
  readonly requestId: string;
  readonly actor: NeedsChangesActor;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly body: string;
}

export interface NeedsChangesDecisionResult {
  readonly status: "CHANGES_REQUESTED";
  readonly requestId: string;
  readonly actor: NeedsChangesActor;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly observedHeadSha: string;
  readonly expectedMainSha: string;
  readonly observedMainSha: string;
  readonly observedAt: string;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly submittedAt: string;
}

export interface NeedsChangesAuditClaimInput {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly actor: NeedsChangesActor;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly requestedAt: string;
}

export type NeedsChangesAuditTerminalOutcome =
  | { readonly kind: "SUCCEEDED"; readonly result: NeedsChangesDecisionResult }
  | { readonly kind: "FAILED"; readonly code: NeedsChangesDecisionFailureCode }
  | { readonly kind: "UNKNOWN"; readonly code: "WRITE_OUTCOME_UNKNOWN" };

export type NeedsChangesAuditClaimResult =
  | { readonly kind: "CLAIMED" }
  | { readonly kind: "REPLAY"; readonly outcome: NeedsChangesAuditTerminalOutcome }
  | { readonly kind: "IN_PROGRESS" }
  | { readonly kind: "CONFLICT" };

export interface NeedsChangesDecisionAuditStore {
  claim(input: NeedsChangesAuditClaimInput): Promise<NeedsChangesAuditClaimResult>;
  complete(
    requestId: string,
    fingerprint: string,
    outcome: NeedsChangesAuditTerminalOutcome,
  ): Promise<void>;
}

export interface NeedsChangesDecisionDependencies {
  readonly provider: SourceControlReadProvider;
  readonly branchPolicyReader: BranchPolicyEvidenceReader;
  readonly writer: GitHubPullRequestReviewWriter;
  readonly auditStore: NeedsChangesDecisionAuditStore;
  readonly clock?: () => Date;
}

function hasForbiddenControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 127;
  });
}

function boundedActorValue(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    hasForbiddenControlCharacters(value) ||
    new TextEncoder().encode(value).byteLength > NEEDS_CHANGES_ACTOR_MAX_BYTES
  ) {
    throw new NeedsChangesDecisionError("INVALID_REQUEST");
  }
  return value;
}

function normalizeActor(actor: NeedsChangesActor): NeedsChangesActor {
  if (!actor || typeof actor !== "object") throw new NeedsChangesDecisionError("INVALID_REQUEST");
  const subject = boundedActorValue(actor.subject);
  const email = actor.email === null ? null : boundedActorValue(actor.email);
  return { subject, email };
}

function normalizeRepository(repository: string): string {
  try {
    return requireManagedProjectPolicy(repository).repository;
  } catch {
    throw new NeedsChangesDecisionError("INVALID_REQUEST");
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new NeedsChangesDecisionError("INVALID_REQUEST");
  return value;
}

function exactSha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new NeedsChangesDecisionError("INVALID_REQUEST");
  return value;
}

function requestId(value: string): string {
  if (!NEEDS_CHANGES_REQUEST_ID_PATTERN.test(value)) {
    throw new NeedsChangesDecisionError("INVALID_REQUEST");
  }
  return value;
}

function reviewBody(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || hasForbiddenControlCharacters(value)) {
    throw new NeedsChangesDecisionError("INVALID_REQUEST");
  }
  if (new TextEncoder().encode(value).byteLength > 4096) {
    throw new NeedsChangesDecisionError("INVALID_REQUEST");
  }
  return value;
}

function normalizeNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new NeedsChangesDecisionError("INVALID_REQUEST");
  }
  return value.toISOString();
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fingerprint(input: {
  readonly actor: NeedsChangesActor;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly body: string;
}): Promise<string> {
  const canonical = JSON.stringify([
    input.actor.subject,
    input.actor.email,
    input.repository,
    input.issueNumber,
    input.pullNumber,
    input.expectedHeadSha,
    input.expectedMainSha,
    input.body,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return hex(new Uint8Array(digest));
}

function replay(outcome: NeedsChangesAuditTerminalOutcome): NeedsChangesDecisionResult {
  if (outcome.kind === "SUCCEEDED") return outcome.result;
  if (outcome.kind === "UNKNOWN") throw new NeedsChangesDecisionError("WRITE_OUTCOME_UNKNOWN");
  throw new NeedsChangesDecisionError(outcome.code);
}

async function completeOrFail(
  store: NeedsChangesDecisionAuditStore,
  requestIdValue: string,
  fingerprintValue: string,
  outcome: NeedsChangesAuditTerminalOutcome,
  mutationAttempted: boolean,
): Promise<void> {
  try {
    await store.complete(requestIdValue, fingerprintValue, outcome);
  } catch {
    throw new NeedsChangesDecisionError("AUDIT_FINALIZATION_FAILED", mutationAttempted);
  }
}

async function failBeforeWrite(
  store: NeedsChangesDecisionAuditStore,
  requestIdValue: string,
  fingerprintValue: string,
  code: NeedsChangesDecisionFailureCode,
): Promise<never> {
  await completeOrFail(store, requestIdValue, fingerprintValue, { kind: "FAILED", code }, false);
  throw new NeedsChangesDecisionError(code, false);
}

function writeFailureCode(error: GitHubPullRequestReviewWriteError): NeedsChangesDecisionFailureCode {
  return error.code === "WRITE_OUTCOME_UNKNOWN" ? "WRITE_OUTCOME_UNKNOWN" : "WRITE_REJECTED";
}

export async function executeNeedsChangesDecision(
  request: NeedsChangesDecisionRequest,
  dependencies: NeedsChangesDecisionDependencies,
): Promise<NeedsChangesDecisionResult> {
  const normalized = {
    requestId: requestId(request.requestId),
    actor: normalizeActor(request.actor),
    repository: normalizeRepository(request.repository),
    issueNumber: positiveInteger(request.issueNumber),
    pullNumber: positiveInteger(request.pullNumber),
    expectedHeadSha: exactSha(request.expectedHeadSha),
    expectedMainSha: exactSha(request.expectedMainSha),
    body: reviewBody(request.body),
  };
  const requestedAt = normalizeNow(dependencies.clock ?? (() => new Date()));
  const fingerprintValue = await fingerprint(normalized);

  const claim = await dependencies.auditStore.claim({
    requestId: normalized.requestId,
    fingerprint: fingerprintValue,
    actor: normalized.actor,
    repository: normalized.repository,
    issueNumber: normalized.issueNumber,
    pullNumber: normalized.pullNumber,
    expectedHeadSha: normalized.expectedHeadSha,
    expectedMainSha: normalized.expectedMainSha,
    requestedAt,
  });

  if (claim.kind === "REPLAY") return replay(claim.outcome);
  if (claim.kind === "IN_PROGRESS") throw new NeedsChangesDecisionError("IDEMPOTENCY_IN_PROGRESS");
  if (claim.kind === "CONFLICT") throw new NeedsChangesDecisionError("IDEMPOTENCY_CONFLICT");

  let reconciliation;
  try {
    reconciliation = await reconcileAuthoritativePullRequestDecision({
      provider: dependencies.provider,
      branchPolicyReader: dependencies.branchPolicyReader,
      repository: normalized.repository,
      issueNumber: normalized.issueNumber,
      pullNumber: normalized.pullNumber,
      observedAt: requestedAt,
    });
  } catch (error) {
    const code =
      error instanceof AuthoritativeReconciliationError && error.code === "INVALID_REQUEST"
        ? "INVALID_REQUEST"
        : "RECONCILIATION_FAILED";
    return failBeforeWrite(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      code,
    );
  }

  if (reconciliation.kind !== "PROJECTED" || reconciliation.policy.coverage !== "COMPLETE") {
    return failBeforeWrite(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      "POLICY_EVIDENCE_INCOMPLETE",
    );
  }

  const decision = reconciliation.decision;
  if (
    decision.expectedHeadSha !== normalized.expectedHeadSha ||
    decision.currentHeadSha !== normalized.expectedHeadSha
  ) {
    return failBeforeWrite(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      "AUTHORIZATION_STALE_HEAD",
    );
  }

  if (decision.mainSha !== normalized.expectedMainSha) {
    return failBeforeWrite(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      "AUTHORIZATION_STALE_BASE",
    );
  }

  if (
    decision.prNumber !== normalized.pullNumber ||
    decision.issueNumber !== normalized.issueNumber ||
    decision.workflowState !== "MERGE_READY" ||
    decision.ci !== "PASS" ||
    decision.review !== "PASS"
  ) {
    return failBeforeWrite(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      "DECISION_NOT_READY",
    );
  }

  let write: GitHubRequestChangesWriteResult;
  try {
    write = await dependencies.writer.requestChanges({
      repository: normalized.repository,
      pullNumber: normalized.pullNumber,
      expectedHeadSha: normalized.expectedHeadSha,
      body: normalized.body,
      observedAt: requestedAt,
    });
  } catch (error) {
    const code =
      error instanceof GitHubPullRequestReviewWriteError
        ? writeFailureCode(error)
        : "WRITE_OUTCOME_UNKNOWN";
    const outcome: NeedsChangesAuditTerminalOutcome =
      code === "WRITE_OUTCOME_UNKNOWN"
        ? { kind: "UNKNOWN", code: "WRITE_OUTCOME_UNKNOWN" }
        : { kind: "FAILED", code };
    await completeOrFail(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      outcome,
      true,
    );
    throw new NeedsChangesDecisionError(code, true);
  }

  if (write.state !== "CHANGES_REQUESTED" || write.commitId !== normalized.expectedHeadSha) {
    await completeOrFail(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      { kind: "UNKNOWN", code: "WRITE_OUTCOME_UNKNOWN" },
      true,
    );
    throw new NeedsChangesDecisionError("WRITE_OUTCOME_UNKNOWN", true);
  }

  const result: NeedsChangesDecisionResult = {
    status: "CHANGES_REQUESTED",
    requestId: normalized.requestId,
    actor: normalized.actor,
    repository: normalized.repository,
    issueNumber: normalized.issueNumber,
    pullNumber: normalized.pullNumber,
    expectedHeadSha: normalized.expectedHeadSha,
    observedHeadSha: decision.currentHeadSha,
    expectedMainSha: normalized.expectedMainSha,
    observedMainSha: decision.mainSha,
    observedAt: requestedAt,
    reviewId: write.reviewId,
    reviewUrl: write.htmlUrl,
    submittedAt: write.submittedAt,
  };

  await completeOrFail(
    dependencies.auditStore,
    normalized.requestId,
    fingerprintValue,
    { kind: "SUCCEEDED", result },
    true,
  );
  return result;
}
