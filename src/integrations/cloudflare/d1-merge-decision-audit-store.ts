import {
  MERGE_ACTOR_MAX_BYTES,
  MERGE_REQUEST_ID_PATTERN,
  type MergeAuditClaimInput,
  type MergeAuditClaimResult,
  type MergeAuditTerminalOutcome,
  type MergeDecisionActor,
  type MergeDecisionAuditStore,
  type MergeDecisionFailureCode,
  type MergeDecisionResult,
} from "../../shared/merge-decision.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import {
  GITHUB_MERGE_METHODS,
  type GitHubMergeMethod,
} from "../github/pull-request-merge-write.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{40}$/;

type PersistedMergeFailureCode =
  | "INVALID_REQUEST"
  | "POLICY_EVIDENCE_INCOMPLETE"
  | "AUTHORIZATION_STALE_HEAD"
  | "AUTHORIZATION_STALE_BASE"
  | "DECISION_NOT_READY"
  | "RECONCILIATION_FAILED"
  | "WRITE_REJECTED";

const storedFailureCodes = new Set<PersistedMergeFailureCode>([
  "INVALID_REQUEST",
  "POLICY_EVIDENCE_INCOMPLETE",
  "AUTHORIZATION_STALE_HEAD",
  "AUTHORIZATION_STALE_BASE",
  "DECISION_NOT_READY",
  "RECONCILIATION_FAILED",
  "WRITE_REJECTED",
]);

const INSERT_CLAIM_SQL = `
INSERT INTO merge_decisions (
  request_id,
  fingerprint,
  actor_subject,
  actor_email,
  repository,
  project_id,
  issue_number,
  pull_number,
  merge_method,
  expected_head_sha,
  expected_main_sha,
  requested_at,
  state
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'IN_PROGRESS')
ON CONFLICT(request_id) DO NOTHING
`.trim();

const READ_DECISION_SQL = `
SELECT
  request_id,
  fingerprint,
  actor_subject,
  actor_email,
  repository,
  project_id,
  issue_number,
  pull_number,
  merge_method,
  expected_head_sha,
  expected_main_sha,
  requested_at,
  state,
  outcome_code,
  mutation_attempted,
  observed_head_sha,
  observed_main_sha,
  observed_at,
  merge_sha,
  completed_at
FROM merge_decisions
WHERE request_id = ?1
LIMIT 1
`.trim();

const COMPLETE_SUCCESS_SQL = `
UPDATE merge_decisions
SET
  state = 'SUCCEEDED',
  outcome_code = NULL,
  mutation_attempted = 1,
  observed_head_sha = ?12,
  observed_main_sha = ?13,
  observed_at = ?14,
  merge_sha = ?15,
  completed_at = ?16
WHERE
  request_id = ?1
  AND fingerprint = ?2
  AND actor_subject = ?3
  AND actor_email IS ?4
  AND repository = ?5
  AND project_id = ?6
  AND issue_number = ?7
  AND pull_number = ?8
  AND merge_method = ?9
  AND expected_head_sha = ?10
  AND expected_main_sha = ?11
  AND state = 'IN_PROGRESS'
`.trim();

const COMPLETE_FAILED_SQL = `
UPDATE merge_decisions
SET
  state = 'FAILED',
  outcome_code = ?3,
  mutation_attempted = ?4,
  completed_at = ?5
WHERE
  request_id = ?1
  AND fingerprint = ?2
  AND state = 'IN_PROGRESS'
`.trim();

const COMPLETE_UNKNOWN_SQL = `
UPDATE merge_decisions
SET
  state = 'UNKNOWN',
  outcome_code = 'WRITE_OUTCOME_UNKNOWN',
  mutation_attempted = 1,
  completed_at = ?3
WHERE
  request_id = ?1
  AND fingerprint = ?2
  AND state = 'IN_PROGRESS'
`.trim();

interface StoredMergeDecisionRow {
  readonly request_id: string;
  readonly fingerprint: string;
  readonly actor_subject: string;
  readonly actor_email: string | null;
  readonly repository: string;
  readonly project_id: string;
  readonly issue_number: number;
  readonly pull_number: number;
  readonly merge_method: string;
  readonly expected_head_sha: string;
  readonly expected_main_sha: string;
  readonly requested_at: string;
  readonly state: string;
  readonly outcome_code: string | null;
  readonly mutation_attempted: number | null;
  readonly observed_head_sha: string | null;
  readonly observed_main_sha: string | null;
  readonly observed_at: string | null;
  readonly merge_sha: string | null;
  readonly completed_at: string | null;
}

interface NormalizedClaim {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly actor: MergeDecisionActor;
  readonly repository: string;
  readonly projectId: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly mergeMethod: GitHubMergeMethod;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly requestedAt: string;
}

interface ParsedStoredDecision extends Omit<NormalizedClaim, "requestedAt"> {
  readonly requestedAt: string;
  readonly outcome: "IN_PROGRESS" | MergeAuditTerminalOutcome;
}

export class D1MergeDecisionAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1MergeDecisionAuditError";
  }
}

function hasForbiddenControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 127;
  });
}

function requireRequestId(value: string, field = "requestId"): string {
  if (typeof value !== "string" || !MERGE_REQUEST_ID_PATTERN.test(value)) {
    throw new D1MergeDecisionAuditError(`${field} is malformed`);
  }
  return value;
}

function requireFingerprint(value: string, field = "fingerprint"): string {
  if (typeof value !== "string" || !fingerprintPattern.test(value)) {
    throw new D1MergeDecisionAuditError(`${field} is malformed`);
  }
  return value;
}

function requireActorValue(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    hasForbiddenControlCharacters(value) ||
    new TextEncoder().encode(value).byteLength > MERGE_ACTOR_MAX_BYTES
  ) {
    throw new D1MergeDecisionAuditError(`${field} is malformed`);
  }
  return value;
}

function requireActor(actor: MergeDecisionActor): MergeDecisionActor {
  if (!actor || typeof actor !== "object") {
    throw new D1MergeDecisionAuditError("actor is malformed");
  }
  return {
    subject: requireActorValue(actor.subject, "actor subject"),
    email: actor.email === null ? null : requireActorValue(actor.email, "actor email"),
  };
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new D1MergeDecisionAuditError(`${field} is malformed`);
  }
  return value;
}

function requireSha(value: string, field: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw new D1MergeDecisionAuditError(`${field} is malformed`);
  }
  return value;
}

function requireMergeMethod(value: string, field = "mergeMethod"): GitHubMergeMethod {
  if (!(GITHUB_MERGE_METHODS as readonly string[]).includes(value)) {
    throw new D1MergeDecisionAuditError(`${field} is malformed`);
  }
  return value as GitHubMergeMethod;
}

function requireUtcTimestamp(value: string, field: string): string {
  if (typeof value !== "string" || !utcTimestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new D1MergeDecisionAuditError(`${field} must be a UTC ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function requireNullableTimestamp(value: string | null, field: string): string | null {
  return value === null ? null : requireUtcTimestamp(value, field);
}

function requireMutationAttempted(value: number | null, field: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new D1MergeDecisionAuditError(`${field} is malformed`);
  }
  return value === 1;
}

function requireFailureCode(value: string | null): PersistedMergeFailureCode {
  if (value === null || !storedFailureCodes.has(value as PersistedMergeFailureCode)) {
    throw new D1MergeDecisionAuditError("stored failure outcome code is unsupported");
  }
  return value as PersistedMergeFailureCode;
}

function requireSuccessfulResult<Row>(result: D1RunResultLike<Row>, operation: string): void {
  if (result.success !== true) {
    throw new D1MergeDecisionAuditError(`D1 ${operation} did not report success`);
  }
}

function requireExactChange(result: D1RunResultLike, operation: string): void {
  requireSuccessfulResult(result, operation);
  if (result.meta.changes !== 1) {
    throw new D1MergeDecisionAuditError(`D1 ${operation} did not update exactly one IN_PROGRESS decision`);
  }
}

function normalizeClaim(input: MergeAuditClaimInput): NormalizedClaim {
  const project = requireManagedProjectPolicy(input.repository);
  return {
    requestId: requireRequestId(input.requestId),
    fingerprint: requireFingerprint(input.fingerprint),
    actor: requireActor(input.actor),
    repository: project.repository,
    projectId: project.id,
    issueNumber: requirePositiveInteger(input.issueNumber, "issueNumber"),
    pullNumber: requirePositiveInteger(input.pullNumber, "pullNumber"),
    mergeMethod: requireMergeMethod(input.mergeMethod),
    expectedHeadSha: requireSha(input.expectedHeadSha, "expectedHeadSha"),
    expectedMainSha: requireSha(input.expectedMainSha, "expectedMainSha"),
    requestedAt: requireUtcTimestamp(input.requestedAt, "requestedAt"),
  };
}

function allNull(values: readonly (string | null)[]): boolean {
  return values.every((value) => value === null);
}

function parseStoredDecision(row: StoredMergeDecisionRow): ParsedStoredDecision {
  const requestId = requireRequestId(row.request_id, "stored requestId");
  const fingerprint = requireFingerprint(row.fingerprint, "stored fingerprint");
  const actor = requireActor({ subject: row.actor_subject, email: row.actor_email });
  const project = requireManagedProjectPolicy(row.repository);
  if (row.project_id !== project.id) {
    throw new D1MergeDecisionAuditError("stored project does not match repository policy");
  }

  const issueNumber = requirePositiveInteger(row.issue_number, "stored issueNumber");
  const pullNumber = requirePositiveInteger(row.pull_number, "stored pullNumber");
  const mergeMethod = requireMergeMethod(row.merge_method, "stored mergeMethod");
  const expectedHeadSha = requireSha(row.expected_head_sha, "stored expectedHeadSha");
  const expectedMainSha = requireSha(row.expected_main_sha, "stored expectedMainSha");
  const requestedAt = requireUtcTimestamp(row.requested_at, "stored requestedAt");
  const completedAt = requireNullableTimestamp(row.completed_at, "stored completedAt");
  const successEvidence = [row.observed_head_sha, row.observed_main_sha, row.observed_at, row.merge_sha] as const;

  const identity = {
    requestId,
    fingerprint,
    actor,
    repository: project.repository,
    projectId: project.id,
    issueNumber,
    pullNumber,
    mergeMethod,
    expectedHeadSha,
    expectedMainSha,
    requestedAt,
  };

  if (row.state === "IN_PROGRESS") {
    if (row.outcome_code !== null || row.mutation_attempted !== null || completedAt !== null || !allNull(successEvidence)) {
      throw new D1MergeDecisionAuditError("stored IN_PROGRESS decision contains terminal evidence");
    }
    return { ...identity, outcome: "IN_PROGRESS" };
  }

  if (row.state === "FAILED") {
    if (completedAt === null || !allNull(successEvidence)) {
      throw new D1MergeDecisionAuditError("stored FAILED decision has invalid evidence shape");
    }
    return {
      ...identity,
      outcome: {
        kind: "FAILED",
        code: requireFailureCode(row.outcome_code),
        mutationAttempted: requireMutationAttempted(row.mutation_attempted, "stored mutationAttempted"),
      },
    };
  }

  if (row.state === "UNKNOWN") {
    if (
      row.outcome_code !== "WRITE_OUTCOME_UNKNOWN" ||
      completedAt === null ||
      row.mutation_attempted !== 1 ||
      !allNull(successEvidence)
    ) {
      throw new D1MergeDecisionAuditError("stored UNKNOWN decision has invalid evidence shape");
    }
    return {
      ...identity,
      outcome: { kind: "UNKNOWN", code: "WRITE_OUTCOME_UNKNOWN", mutationAttempted: true },
    };
  }

  if (row.state === "SUCCEEDED") {
    if (
      row.outcome_code !== null ||
      row.mutation_attempted !== 1 ||
      completedAt === null ||
      successEvidence.some((value) => value === null)
    ) {
      throw new D1MergeDecisionAuditError("stored SUCCEEDED decision has incomplete evidence");
    }

    const observedHeadSha = requireSha(row.observed_head_sha as string, "stored observedHeadSha");
    const observedMainSha = requireSha(row.observed_main_sha as string, "stored observedMainSha");
    if (observedHeadSha !== expectedHeadSha || observedMainSha !== expectedMainSha) {
      throw new D1MergeDecisionAuditError("stored success evidence does not match authorized head/base");
    }
    const observedAt = requireUtcTimestamp(row.observed_at as string, "stored observedAt");
    const mergeSha = requireSha(row.merge_sha as string, "stored mergeSha");
    const result: MergeDecisionResult = {
      status: "MERGED",
      requestId,
      actor,
      repository: project.repository,
      issueNumber,
      pullNumber,
      mergeMethod,
      expectedHeadSha,
      observedHeadSha,
      expectedMainSha,
      observedMainSha,
      observedAt,
      mergeSha,
    };
    return { ...identity, outcome: { kind: "SUCCEEDED", result } };
  }

  throw new D1MergeDecisionAuditError("stored decision state is unsupported");
}

function sameClaimIdentity(stored: ParsedStoredDecision, claim: NormalizedClaim): boolean {
  return (
    stored.actor.subject === claim.actor.subject &&
    stored.actor.email === claim.actor.email &&
    stored.repository === claim.repository &&
    stored.projectId === claim.projectId &&
    stored.issueNumber === claim.issueNumber &&
    stored.pullNumber === claim.pullNumber &&
    stored.mergeMethod === claim.mergeMethod &&
    stored.expectedHeadSha === claim.expectedHeadSha &&
    stored.expectedMainSha === claim.expectedMainSha
  );
}

function normalizeCompletionTime(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new D1MergeDecisionAuditError("completion clock returned an invalid time");
  }
  return value.toISOString();
}

function normalizeSuccessResult(
  requestId: string,
  result: MergeDecisionResult,
): MergeDecisionResult & { readonly projectId: string } {
  if (!result || typeof result !== "object" || result.status !== "MERGED") {
    throw new D1MergeDecisionAuditError("success result is malformed");
  }
  const normalizedRequestId = requireRequestId(result.requestId, "result requestId");
  if (normalizedRequestId !== requestId) {
    throw new D1MergeDecisionAuditError("success result requestId does not match completion requestId");
  }

  const actor = requireActor(result.actor);
  const project = requireManagedProjectPolicy(result.repository);
  const issueNumber = requirePositiveInteger(result.issueNumber, "result issueNumber");
  const pullNumber = requirePositiveInteger(result.pullNumber, "result pullNumber");
  const mergeMethod = requireMergeMethod(result.mergeMethod, "result mergeMethod");
  const expectedHeadSha = requireSha(result.expectedHeadSha, "result expectedHeadSha");
  const observedHeadSha = requireSha(result.observedHeadSha, "result observedHeadSha");
  const expectedMainSha = requireSha(result.expectedMainSha, "result expectedMainSha");
  const observedMainSha = requireSha(result.observedMainSha, "result observedMainSha");
  if (observedHeadSha !== expectedHeadSha || observedMainSha !== expectedMainSha) {
    throw new D1MergeDecisionAuditError("success result does not match authorized head/base");
  }
  const observedAt = requireUtcTimestamp(result.observedAt, "result observedAt");
  const mergeSha = requireSha(result.mergeSha, "result mergeSha");

  return {
    status: "MERGED",
    requestId: normalizedRequestId,
    actor,
    repository: project.repository,
    projectId: project.id,
    issueNumber,
    pullNumber,
    mergeMethod,
    expectedHeadSha,
    observedHeadSha,
    expectedMainSha,
    observedMainSha,
    observedAt,
    mergeSha,
  };
}

function requirePersistedFailureCode(code: Exclude<MergeDecisionFailureCode, "WRITE_OUTCOME_UNKNOWN">): PersistedMergeFailureCode {
  if (!storedFailureCodes.has(code as PersistedMergeFailureCode)) {
    throw new D1MergeDecisionAuditError("failure outcome code is not persistable");
  }
  return code as PersistedMergeFailureCode;
}

export class D1MergeDecisionAuditStore implements MergeDecisionAuditStore {
  readonly #database: D1DatabaseLike;
  readonly #clock: () => Date;

  constructor(database: D1DatabaseLike, clock: () => Date = () => new Date()) {
    this.#database = database;
    this.#clock = clock;
  }

  async claim(input: MergeAuditClaimInput): Promise<MergeAuditClaimResult> {
    const claim = normalizeClaim(input);
    const insert = await this.#database
      .prepare(INSERT_CLAIM_SQL)
      .bind(
        claim.requestId,
        claim.fingerprint,
        claim.actor.subject,
        claim.actor.email,
        claim.repository,
        claim.projectId,
        claim.issueNumber,
        claim.pullNumber,
        claim.mergeMethod,
        claim.expectedHeadSha,
        claim.expectedMainSha,
        claim.requestedAt,
      )
      .run();

    requireSuccessfulResult(insert, "Merge claim insert");
    if (insert.meta.changes === 1) return { kind: "CLAIMED" };
    if (insert.meta.changes !== 0) {
      throw new D1MergeDecisionAuditError("D1 Merge claim insert returned an unexpected change count");
    }

    const existing = await this.#database
      .prepare(READ_DECISION_SQL)
      .bind(claim.requestId)
      .run<StoredMergeDecisionRow>();
    requireSuccessfulResult(existing, "Merge duplicate read");
    if (existing.results.length !== 1) {
      throw new D1MergeDecisionAuditError("D1 Merge request identity could not be uniquely proven");
    }

    const stored = parseStoredDecision(existing.results[0]);
    if (stored.fingerprint !== claim.fingerprint) return { kind: "CONFLICT" };
    if (!sameClaimIdentity(stored, claim)) {
      throw new D1MergeDecisionAuditError("D1 Merge duplicate identity does not match the fingerprinted claim");
    }
    if (stored.outcome === "IN_PROGRESS") return { kind: "IN_PROGRESS" };
    return { kind: "REPLAY", outcome: stored.outcome };
  }

  async complete(
    requestIdValue: string,
    fingerprintValue: string,
    outcome: MergeAuditTerminalOutcome,
  ): Promise<void> {
    const requestId = requireRequestId(requestIdValue);
    const fingerprint = requireFingerprint(fingerprintValue);
    const completedAt = normalizeCompletionTime(this.#clock);

    if (outcome.kind === "SUCCEEDED") {
      const result = normalizeSuccessResult(requestId, outcome.result);
      const update = await this.#database
        .prepare(COMPLETE_SUCCESS_SQL)
        .bind(
          requestId,
          fingerprint,
          result.actor.subject,
          result.actor.email,
          result.repository,
          result.projectId,
          result.issueNumber,
          result.pullNumber,
          result.mergeMethod,
          result.expectedHeadSha,
          result.expectedMainSha,
          result.observedHeadSha,
          result.observedMainSha,
          result.observedAt,
          result.mergeSha,
          completedAt,
        )
        .run();
      requireExactChange(update, "Merge success completion");
      return;
    }

    if (outcome.kind === "FAILED") {
      const code = requirePersistedFailureCode(outcome.code);
      const update = await this.#database
        .prepare(COMPLETE_FAILED_SQL)
        .bind(requestId, fingerprint, code, outcome.mutationAttempted ? 1 : 0, completedAt)
        .run();
      requireExactChange(update, "Merge failed completion");
      return;
    }

    if (outcome.kind === "UNKNOWN" && outcome.code === "WRITE_OUTCOME_UNKNOWN" && outcome.mutationAttempted === true) {
      const update = await this.#database
        .prepare(COMPLETE_UNKNOWN_SQL)
        .bind(requestId, fingerprint, completedAt)
        .run();
      requireExactChange(update, "Merge unknown completion");
      return;
    }

    throw new D1MergeDecisionAuditError("terminal outcome is unsupported");
  }
}
