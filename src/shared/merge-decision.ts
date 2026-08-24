import {
  AuthoritativeReconciliationError,
  reconcileAuthoritativePullRequestDecision,
  type BranchPolicyEvidenceReader,
} from "./authoritative-reconciliation.js";
import { isReviewRequirementSatisfied } from "./github-projection.js";
import { requireManagedProjectPolicy } from "./project-policy.js";
import type { SourceControlReadProvider } from "./source-control-read.js";
import {
  GITHUB_MERGE_METHODS,
  GitHubPullRequestMergeWriteError,
  type GitHubMergeMethod,
  type GitHubPullRequestMergeWriter,
} from "../integrations/github/pull-request-merge-write.js";

export const MERGE_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
export const MERGE_ACTOR_MAX_BYTES = 512;

export type MergeDecisionFailureCode =
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

const failureMessages: Readonly<Record<MergeDecisionFailureCode, string>> = {
  INVALID_REQUEST: "Merge decision request failed validation",
  IDEMPOTENCY_CONFLICT: "Merge decision request id conflicts with an earlier request",
  IDEMPOTENCY_IN_PROGRESS: "Merge decision request is already in progress",
  POLICY_EVIDENCE_INCOMPLETE: "Merge decision requires complete live policy evidence",
  AUTHORIZATION_STALE_HEAD: "Merge decision expected head no longer matches live GitHub state",
  AUTHORIZATION_STALE_BASE: "Merge decision expected base no longer matches live GitHub state",
  DECISION_NOT_READY: "Merge decision is not eligible under the fresh authoritative decision state",
  RECONCILIATION_FAILED: "Merge decision authoritative reconciliation failed",
  WRITE_REJECTED: "Merge write was rejected",
  WRITE_OUTCOME_UNKNOWN: "Merge write outcome is unknown",
  AUDIT_FINALIZATION_FAILED: "Merge decision audit finalization failed",
};

export class MergeDecisionError extends Error {
  readonly code: MergeDecisionFailureCode;
  readonly mutationAttempted: boolean;

  constructor(code: MergeDecisionFailureCode, mutationAttempted = false) {
    super(failureMessages[code]);
    this.name = "MergeDecisionError";
    this.code = code;
    this.mutationAttempted = mutationAttempted;
  }
}

export interface MergeDecisionActor {
  readonly subject: string;
  readonly email: string | null;
}

export interface MergeDecisionRequest {
  readonly requestId: string;
  readonly actor: MergeDecisionActor;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly mergeMethod: GitHubMergeMethod;
}

export interface MergeDecisionResult {
  readonly status: "MERGED";
  readonly requestId: string;
  readonly actor: MergeDecisionActor;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly mergeMethod: GitHubMergeMethod;
  readonly expectedHeadSha: string;
  readonly observedHeadSha: string;
  readonly expectedMainSha: string;
  readonly observedMainSha: string;
  readonly observedAt: string;
  readonly mergeSha: string;
}

export interface MergeAuditClaimInput {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly actor: MergeDecisionActor;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly mergeMethod: GitHubMergeMethod;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly requestedAt: string;
}

export type MergeAuditTerminalOutcome =
  | { readonly kind: "SUCCEEDED"; readonly result: MergeDecisionResult }
  | {
      readonly kind: "FAILED";
      readonly code: Exclude<MergeDecisionFailureCode, "WRITE_OUTCOME_UNKNOWN">;
      readonly mutationAttempted: boolean;
    }
  | {
      readonly kind: "UNKNOWN";
      readonly code: "WRITE_OUTCOME_UNKNOWN";
      readonly mutationAttempted: true;
    };

export type MergeAuditClaimResult =
  | { readonly kind: "CLAIMED" }
  | { readonly kind: "REPLAY"; readonly outcome: MergeAuditTerminalOutcome }
  | { readonly kind: "IN_PROGRESS" }
  | { readonly kind: "CONFLICT" };

export interface MergeDecisionAuditStore {
  claim(input: MergeAuditClaimInput): Promise<MergeAuditClaimResult>;
  complete(
    requestId: string,
    fingerprint: string,
    outcome: MergeAuditTerminalOutcome,
  ): Promise<void>;
}

export interface MergeDecisionDependencies {
  readonly provider: SourceControlReadProvider;
  readonly branchPolicyReader: BranchPolicyEvidenceReader;
  readonly writer: GitHubPullRequestMergeWriter;
  readonly auditStore: MergeDecisionAuditStore;
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
    new TextEncoder().encode(value).byteLength > MERGE_ACTOR_MAX_BYTES
  ) {
    throw new MergeDecisionError("INVALID_REQUEST");
  }
  return value;
}

function normalizeActor(actor: MergeDecisionActor): MergeDecisionActor {
  if (!actor || typeof actor !== "object") throw new MergeDecisionError("INVALID_REQUEST");
  const subject = boundedActorValue(actor.subject);
  const email = actor.email === null ? null : boundedActorValue(actor.email);
  return { subject, email };
}

function normalizeRepository(repository: string): string {
  try {
    return requireManagedProjectPolicy(repository).repository;
  } catch {
    throw new MergeDecisionError("INVALID_REQUEST");
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new MergeDecisionError("INVALID_REQUEST");
  return value;
}

function exactSha(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new MergeDecisionError("INVALID_REQUEST");
  }
  return value;
}

function normalizeRequestId(value: string): string {
  if (typeof value !== "string" || !MERGE_REQUEST_ID_PATTERN.test(value)) {
    throw new MergeDecisionError("INVALID_REQUEST");
  }
  return value;
}

function normalizeMergeMethod(value: GitHubMergeMethod): GitHubMergeMethod {
  if (!(GITHUB_MERGE_METHODS as readonly string[]).includes(value)) {
    throw new MergeDecisionError("INVALID_REQUEST");
  }
  return value;
}

function normalizeNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new MergeDecisionError("INVALID_REQUEST");
  }
  return value.toISOString();
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fingerprint(input: {
  readonly actor: MergeDecisionActor;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly mergeMethod: GitHubMergeMethod;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
}): Promise<string> {
  const canonical = JSON.stringify([
    input.actor.subject,
    input.actor.email,
    input.repository,
    input.issueNumber,
    input.pullNumber,
    input.mergeMethod,
    input.expectedHeadSha,
    input.expectedMainSha,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return hex(new Uint8Array(digest));
}

function replay(outcome: MergeAuditTerminalOutcome): MergeDecisionResult {
  if (outcome.kind === "SUCCEEDED") return outcome.result;
  throw new MergeDecisionError(outcome.code, outcome.mutationAttempted);
}

async function completeOrFail(
  store: MergeDecisionAuditStore,
  requestId: string,
  fingerprintValue: string,
  outcome: MergeAuditTerminalOutcome,
  mutationAttempted: boolean,
): Promise<void> {
  try {
    await store.complete(requestId, fingerprintValue, outcome);
  } catch {
    throw new MergeDecisionError("AUDIT_FINALIZATION_FAILED", mutationAttempted);
  }
}

async function failBeforeWrite(
  store: MergeDecisionAuditStore,
  requestId: string,
  fingerprintValue: string,
  code: Exclude<MergeDecisionFailureCode, "WRITE_OUTCOME_UNKNOWN" | "AUDIT_FINALIZATION_FAILED">,
): Promise<never> {
  await completeOrFail(
    store,
    requestId,
    fingerprintValue,
    { kind: "FAILED", code, mutationAttempted: false },
    false,
  );
  throw new MergeDecisionError(code, false);
}

function writerFailure(error: unknown): {
  readonly code: MergeDecisionFailureCode;
  readonly outcome: MergeAuditTerminalOutcome;
} {
  if (!(error instanceof GitHubPullRequestMergeWriteError)) {
    return {
      code: "WRITE_OUTCOME_UNKNOWN",
      outcome: { kind: "UNKNOWN", code: "WRITE_OUTCOME_UNKNOWN", mutationAttempted: true },
    };
  }
  if (error.code === "WRITE_OUTCOME_UNKNOWN") {
    return {
      code: "WRITE_OUTCOME_UNKNOWN",
      outcome: { kind: "UNKNOWN", code: "WRITE_OUTCOME_UNKNOWN", mutationAttempted: true },
    };
  }
  if (error.code === "HEAD_CONFLICT") {
    return {
      code: "AUTHORIZATION_STALE_HEAD",
      outcome: { kind: "FAILED", code: "AUTHORIZATION_STALE_HEAD", mutationAttempted: true },
    };
  }
  return {
    code: "WRITE_REJECTED",
    outcome: { kind: "FAILED", code: "WRITE_REJECTED", mutationAttempted: true },
  };
}

export async function executeMergeDecision(
  request: MergeDecisionRequest,
  dependencies: MergeDecisionDependencies,
): Promise<MergeDecisionResult> {
  const normalized = {
    requestId: normalizeRequestId(request.requestId),
    actor: normalizeActor(request.actor),
    repository: normalizeRepository(request.repository),
    issueNumber: positiveInteger(request.issueNumber),
    pullNumber: positiveInteger(request.pullNumber),
    mergeMethod: normalizeMergeMethod(request.mergeMethod),
    expectedHeadSha: exactSha(request.expectedHeadSha),
    expectedMainSha: exactSha(request.expectedMainSha),
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
    mergeMethod: normalized.mergeMethod,
    expectedHeadSha: normalized.expectedHeadSha,
    expectedMainSha: normalized.expectedMainSha,
    requestedAt,
  });

  if (claim.kind === "REPLAY") return replay(claim.outcome);
  if (claim.kind === "IN_PROGRESS") throw new MergeDecisionError("IDEMPOTENCY_IN_PROGRESS");
  if (claim.kind === "CONFLICT") throw new MergeDecisionError("IDEMPOTENCY_CONFLICT");

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
    !isReviewRequirementSatisfied(decision.review)
  ) {
    return failBeforeWrite(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      "DECISION_NOT_READY",
    );
  }

  let write;
  try {
    write = await dependencies.writer.merge({
      repository: normalized.repository,
      pullNumber: normalized.pullNumber,
      expectedHeadSha: normalized.expectedHeadSha,
      mergeMethod: normalized.mergeMethod,
      observedAt: requestedAt,
    });
  } catch (error) {
    const failure = writerFailure(error);
    await completeOrFail(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      failure.outcome,
      true,
    );
    throw new MergeDecisionError(failure.code, true);
  }

  if (write.merged !== true || !/^[0-9a-f]{40}$/.test(write.mergeSha)) {
    await completeOrFail(
      dependencies.auditStore,
      normalized.requestId,
      fingerprintValue,
      { kind: "UNKNOWN", code: "WRITE_OUTCOME_UNKNOWN", mutationAttempted: true },
      true,
    );
    throw new MergeDecisionError("WRITE_OUTCOME_UNKNOWN", true);
  }

  const result: MergeDecisionResult = {
    status: "MERGED",
    requestId: normalized.requestId,
    actor: normalized.actor,
    repository: normalized.repository,
    issueNumber: normalized.issueNumber,
    pullNumber: normalized.pullNumber,
    mergeMethod: normalized.mergeMethod,
    expectedHeadSha: normalized.expectedHeadSha,
    observedHeadSha: decision.currentHeadSha,
    expectedMainSha: normalized.expectedMainSha,
    observedMainSha: decision.mainSha,
    observedAt: requestedAt,
    mergeSha: write.mergeSha,
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
