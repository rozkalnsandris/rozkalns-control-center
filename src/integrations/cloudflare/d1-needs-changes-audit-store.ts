import {
  NEEDS_CHANGES_ACTOR_MAX_BYTES,
  NEEDS_CHANGES_REQUEST_ID_PATTERN,
  type NeedsChangesActor,
  type NeedsChangesAuditClaimInput,
  type NeedsChangesAuditClaimResult,
  type NeedsChangesAuditTerminalOutcome,
  type NeedsChangesDecisionAuditStore,
  type NeedsChangesDecisionFailureCode,
  type NeedsChangesDecisionResult,
} from "../../shared/needs-changes-decision.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const reviewIdPattern = /^[1-9][0-9]*$/;

const storedFailureCodes = new Set<NeedsChangesDecisionFailureCode>([
  "INVALID_REQUEST",
  "POLICY_EVIDENCE_INCOMPLETE",
  "AUTHORIZATION_STALE_HEAD",
  "AUTHORIZATION_STALE_BASE",
  "DECISION_NOT_READY",
  "RECONCILIATION_FAILED",
  "WRITE_REJECTED",
]);

const INSERT_CLAIM_SQL = `
INSERT INTO needs_changes_decisions (
  request_id,
  fingerprint,
  actor_subject,
  actor_email,
  repository,
  project_id,
  issue_number,
  pull_number,
  expected_head_sha,
  expected_main_sha,
  requested_at,
  state
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'IN_PROGRESS')
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
  expected_head_sha,
  expected_main_sha,
  requested_at,
  state,
  outcome_code,
  observed_head_sha,
  observed_main_sha,
  observed_at,
  review_id,
  review_url,
  submitted_at,
  completed_at
FROM needs_changes_decisions
WHERE request_id = ?1
LIMIT 1
`.trim();

const COMPLETE_SUCCESS_SQL = `
UPDATE needs_changes_decisions
SET
  state = 'SUCCEEDED',
  outcome_code = NULL,
  observed_head_sha = ?11,
  observed_main_sha = ?12,
  observed_at = ?13,
  review_id = ?14,
  review_url = ?15,
  submitted_at = ?16,
  completed_at = ?17
WHERE
  request_id = ?1
  AND fingerprint = ?2
  AND actor_subject = ?3
  AND actor_email IS ?4
  AND repository = ?5
  AND project_id = ?6
  AND issue_number = ?7
  AND pull_number = ?8
  AND expected_head_sha = ?9
  AND expected_main_sha = ?10
  AND state = 'IN_PROGRESS'
`.trim();

const COMPLETE_FAILED_SQL = `
UPDATE needs_changes_decisions
SET
  state = 'FAILED',
  outcome_code = ?3,
  completed_at = ?4
WHERE
  request_id = ?1
  AND fingerprint = ?2
  AND state = 'IN_PROGRESS'
`.trim();

const COMPLETE_UNKNOWN_SQL = `
UPDATE needs_changes_decisions
SET
  state = 'UNKNOWN',
  outcome_code = 'WRITE_OUTCOME_UNKNOWN',
  completed_at = ?3
WHERE
  request_id = ?1
  AND fingerprint = ?2
  AND state = 'IN_PROGRESS'
`.trim();

interface StoredDecisionRow {
  readonly request_id: string;
  readonly fingerprint: string;
  readonly actor_subject: string;
  readonly actor_email: string | null;
  readonly repository: string;
  readonly project_id: string;
  readonly issue_number: number;
  readonly pull_number: number;
  readonly expected_head_sha: string;
  readonly expected_main_sha: string;
  readonly requested_at: string;
  readonly state: string;
  readonly outcome_code: string | null;
  readonly observed_head_sha: string | null;
  readonly observed_main_sha: string | null;
  readonly observed_at: string | null;
  readonly review_id: string | null;
  readonly review_url: string | null;
  readonly submitted_at: string | null;
  readonly completed_at: string | null;
}

interface NormalizedClaim {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly actor: NeedsChangesActor;
  readonly repository: string;
  readonly projectId: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly requestedAt: string;
}

interface ParsedStoredDecision extends Omit<NormalizedClaim, "requestedAt"> {
  readonly requestedAt: string;
  readonly outcome: "IN_PROGRESS" | NeedsChangesAuditTerminalOutcome;
}

export class D1NeedsChangesAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1NeedsChangesAuditError";
  }
}

function hasForbiddenControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 127;
  });
}

function requireRequestId(value: string, field = "requestId"): string {
  if (typeof value !== "string" || !NEEDS_CHANGES_REQUEST_ID_PATTERN.test(value)) {
    throw new D1NeedsChangesAuditError(`${field} is malformed`);
  }
  return value;
}

function requireFingerprint(value: string, field = "fingerprint"): string {
  if (typeof value !== "string" || !fingerprintPattern.test(value)) {
    throw new D1NeedsChangesAuditError(`${field} is malformed`);
  }
  return value;
}

function requireActorValue(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    hasForbiddenControlCharacters(value) ||
    new TextEncoder().encode(value).byteLength > NEEDS_CHANGES_ACTOR_MAX_BYTES
  ) {
    throw new D1NeedsChangesAuditError(`${field} is malformed`);
  }
  return value;
}

function requireActor(actor: NeedsChangesActor): NeedsChangesActor {
  if (!actor || typeof actor !== "object") {
    throw new D1NeedsChangesAuditError("actor is malformed");
  }
  return {
    subject: requireActorValue(actor.subject, "actor subject"),
    email: actor.email === null ? null : requireActorValue(actor.email, "actor email"),
  };
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new D1NeedsChangesAuditError(`${field} is malformed`);
  }
  return value;
}

function requireSha(value: string, field: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw new D1NeedsChangesAuditError(`${field} is malformed`);
  }
  return value;
}

function requireUtcTimestamp(value: string, field: string): string {
  if (typeof value !== "string" || !utcTimestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new D1NeedsChangesAuditError(`${field} must be a UTC ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function requireNullableTimestamp(value: string | null, field: string): string | null {
  return value === null ? null : requireUtcTimestamp(value, field);
}

function requireReviewId(value: string, field = "reviewId"): string {
  if (typeof value !== "string" || !reviewIdPattern.test(value)) {
    throw new D1NeedsChangesAuditError(`${field} is malformed`);
  }
  return value;
}

function requireReviewUrl(value: string, repository: string, pullNumber: number, reviewId: string): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new D1NeedsChangesAuditError("reviewUrl is malformed");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new D1NeedsChangesAuditError("reviewUrl is malformed");
  }

  if (
    url.origin !== "https://github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.pathname.toLowerCase() !== `/${repository}/pull/${pullNumber}`.toLowerCase() ||
    url.hash !== `#pullrequestreview-${reviewId}`
  ) {
    throw new D1NeedsChangesAuditError("reviewUrl does not match the durable decision identity");
  }

  return url.toString();
}

function requireFailureCode(value: string | null): NeedsChangesDecisionFailureCode {
  if (value === null || !storedFailureCodes.has(value as NeedsChangesDecisionFailureCode)) {
    throw new D1NeedsChangesAuditError("stored failure outcome code is unsupported");
  }
  return value as NeedsChangesDecisionFailureCode;
}

function requireSuccessfulResult<Row>(result: D1RunResultLike<Row>, operation: string): void {
  if (result.success !== true) {
    throw new D1NeedsChangesAuditError(`D1 ${operation} did not report success`);
  }
}

function requireExactChange(result: D1RunResultLike, operation: string): void {
  requireSuccessfulResult(result, operation);
  if (result.meta.changes !== 1) {
    throw new D1NeedsChangesAuditError(`D1 ${operation} did not update exactly one IN_PROGRESS decision`);
  }
}

function normalizeClaim(input: NeedsChangesAuditClaimInput): NormalizedClaim {
  const requestId = requireRequestId(input.requestId);
  const fingerprint = requireFingerprint(input.fingerprint);
  const actor = requireActor(input.actor);
  const project = requireManagedProjectPolicy(input.repository);
  return {
    requestId,
    fingerprint,
    actor,
    repository: project.repository,
    projectId: project.id,
    issueNumber: requirePositiveInteger(input.issueNumber, "issueNumber"),
    pullNumber: requirePositiveInteger(input.pullNumber, "pullNumber"),
    expectedHeadSha: requireSha(input.expectedHeadSha, "expectedHeadSha"),
    expectedMainSha: requireSha(input.expectedMainSha, "expectedMainSha"),
    requestedAt: requireUtcTimestamp(input.requestedAt, "requestedAt"),
  };
}

function allNull(values: readonly (string | null)[]): boolean {
  return values.every((value) => value === null);
}

function parseStoredDecision(row: StoredDecisionRow): ParsedStoredDecision {
  const requestId = requireRequestId(row.request_id, "stored requestId");
  const fingerprint = requireFingerprint(row.fingerprint, "stored fingerprint");
  const actor = requireActor({ subject: row.actor_subject, email: row.actor_email });
  const project = requireManagedProjectPolicy(row.repository);
  if (row.project_id !== project.id) {
    throw new D1NeedsChangesAuditError("stored project does not match repository policy");
  }

  const issueNumber = requirePositiveInteger(row.issue_number, "stored issueNumber");
  const pullNumber = requirePositiveInteger(row.pull_number, "stored pullNumber");
  const expectedHeadSha = requireSha(row.expected_head_sha, "stored expectedHeadSha");
  const expectedMainSha = requireSha(row.expected_main_sha, "stored expectedMainSha");
  const requestedAt = requireUtcTimestamp(row.requested_at, "stored requestedAt");
  const completedAt = requireNullableTimestamp(row.completed_at, "stored completedAt");
  const terminalEvidence = [
    row.observed_head_sha,
    row.observed_main_sha,
    row.observed_at,
    row.review_id,
    row.review_url,
    row.submitted_at,
  ] as const;

  if (row.state === "IN_PROGRESS") {
    if (row.outcome_code !== null || completedAt !== null || !allNull(terminalEvidence)) {
      throw new D1NeedsChangesAuditError("stored IN_PROGRESS decision contains terminal evidence");
    }
    return {
      requestId,
      fingerprint,
      actor,
      repository: project.repository,
      projectId: project.id,
      issueNumber,
      pullNumber,
      expectedHeadSha,
      expectedMainSha,
      requestedAt,
      outcome: "IN_PROGRESS",
    };
  }

  if (row.state === "FAILED") {
    if (completedAt === null || !allNull(terminalEvidence)) {
      throw new D1NeedsChangesAuditError("stored FAILED decision has invalid evidence shape");
    }
    return {
      requestId,
      fingerprint,
      actor,
      repository: project.repository,
      projectId: project.id,
      issueNumber,
      pullNumber,
      expectedHeadSha,
      expectedMainSha,
      requestedAt,
      outcome: { kind: "FAILED", code: requireFailureCode(row.outcome_code) },
    };
  }

  if (row.state === "UNKNOWN") {
    if (
      row.outcome_code !== "WRITE_OUTCOME_UNKNOWN" ||
      completedAt === null ||
      !allNull(terminalEvidence)
    ) {
      throw new D1NeedsChangesAuditError("stored UNKNOWN decision has invalid evidence shape");
    }
    return {
      requestId,
      fingerprint,
      actor,
      repository: project.repository,
      projectId: project.id,
      issueNumber,
      pullNumber,
      expectedHeadSha,
      expectedMainSha,
      requestedAt,
      outcome: { kind: "UNKNOWN", code: "WRITE_OUTCOME_UNKNOWN" },
    };
  }

  if (row.state === "SUCCEEDED") {
    if (row.outcome_code !== null || completedAt === null || terminalEvidence.some((value) => value === null)) {
      throw new D1NeedsChangesAuditError("stored SUCCEEDED decision has incomplete evidence");
    }

    const observedHeadSha = requireSha(row.observed_head_sha as string, "stored observedHeadSha");
    const observedMainSha = requireSha(row.observed_main_sha as string, "stored observedMainSha");
    const observedAt = requireUtcTimestamp(row.observed_at as string, "stored observedAt");
    const reviewId = requireReviewId(row.review_id as string, "stored reviewId");
    const reviewUrl = requireReviewUrl(row.review_url as string, project.repository, pullNumber, reviewId);
    const submittedAt = requireUtcTimestamp(row.submitted_at as string, "stored submittedAt");

    const result: NeedsChangesDecisionResult = {
      status: "CHANGES_REQUESTED",
      requestId,
      actor,
      repository: project.repository,
      issueNumber,
      pullNumber,
      expectedHeadSha,
      observedHeadSha,
      expectedMainSha,
      observedMainSha,
      observedAt,
      reviewId,
      reviewUrl,
      submittedAt,
    };

    return {
      requestId,
      fingerprint,
      actor,
      repository: project.repository,
      projectId: project.id,
      issueNumber,
      pullNumber,
      expectedHeadSha,
      expectedMainSha,
      requestedAt,
      outcome: { kind: "SUCCEEDED", result },
    };
  }

  throw new D1NeedsChangesAuditError("stored decision state is unsupported");
}

function sameClaimIdentity(stored: ParsedStoredDecision, claim: NormalizedClaim): boolean {
  return (
    stored.actor.subject === claim.actor.subject &&
    stored.actor.email === claim.actor.email &&
    stored.repository === claim.repository &&
    stored.projectId === claim.projectId &&
    stored.issueNumber === claim.issueNumber &&
    stored.pullNumber === claim.pullNumber &&
    stored.expectedHeadSha === claim.expectedHeadSha &&
    stored.expectedMainSha === claim.expectedMainSha
  );
}

function normalizeCompletionTime(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new D1NeedsChangesAuditError("completion clock returned an invalid time");
  }
  return value.toISOString();
}

function normalizeSuccessResult(
  requestId: string,
  result: NeedsChangesDecisionResult,
): NeedsChangesDecisionResult & { readonly projectId: string } {
  if (!result || typeof result !== "object" || result.status !== "CHANGES_REQUESTED") {
    throw new D1NeedsChangesAuditError("success result is malformed");
  }

  const normalizedRequestId = requireRequestId(result.requestId, "result requestId");
  if (normalizedRequestId !== requestId) {
    throw new D1NeedsChangesAuditError("success result requestId does not match completion requestId");
  }

  const actor = requireActor(result.actor);
  const project = requireManagedProjectPolicy(result.repository);
  const issueNumber = requirePositiveInteger(result.issueNumber, "result issueNumber");
  const pullNumber = requirePositiveInteger(result.pullNumber, "result pullNumber");
  const expectedHeadSha = requireSha(result.expectedHeadSha, "result expectedHeadSha");
  const observedHeadSha = requireSha(result.observedHeadSha, "result observedHeadSha");
  const expectedMainSha = requireSha(result.expectedMainSha, "result expectedMainSha");
  const observedMainSha = requireSha(result.observedMainSha, "result observedMainSha");
  const observedAt = requireUtcTimestamp(result.observedAt, "result observedAt");
  const reviewId = requireReviewId(result.reviewId, "result reviewId");
  const reviewUrl = requireReviewUrl(result.reviewUrl, project.repository, pullNumber, reviewId);
  const submittedAt = requireUtcTimestamp(result.submittedAt, "result submittedAt");

  return {
    status: "CHANGES_REQUESTED",
    requestId: normalizedRequestId,
    actor,
    repository: project.repository,
    projectId: project.id,
    issueNumber,
    pullNumber,
    expectedHeadSha,
    observedHeadSha,
    expectedMainSha,
    observedMainSha,
    observedAt,
    reviewId,
    reviewUrl,
    submittedAt,
  };
}

export class D1NeedsChangesDecisionAuditStore implements NeedsChangesDecisionAuditStore {
  readonly #database: D1DatabaseLike;
  readonly #clock: () => Date;

  constructor(database: D1DatabaseLike, clock: () => Date = () => new Date()) {
    this.#database = database;
    this.#clock = clock;
  }

  async claim(input: NeedsChangesAuditClaimInput): Promise<NeedsChangesAuditClaimResult> {
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
        claim.expectedHeadSha,
        claim.expectedMainSha,
        claim.requestedAt,
      )
      .run();

    requireSuccessfulResult(insert, "Needs changes claim insert");
    if (insert.meta.changes === 1) return { kind: "CLAIMED" };
    if (insert.meta.changes !== 0) {
      throw new D1NeedsChangesAuditError("D1 Needs changes claim insert returned an unexpected change count");
    }

    const existing = await this.#database
      .prepare(READ_DECISION_SQL)
      .bind(claim.requestId)
      .run<StoredDecisionRow>();

    requireSuccessfulResult(existing, "Needs changes duplicate read");
    if (existing.results.length !== 1) {
      throw new D1NeedsChangesAuditError("D1 Needs changes request identity could not be uniquely proven");
    }

    const stored = parseStoredDecision(existing.results[0]);
    if (stored.fingerprint !== claim.fingerprint) return { kind: "CONFLICT" };
    if (!sameClaimIdentity(stored, claim)) {
      throw new D1NeedsChangesAuditError("D1 Needs changes duplicate identity does not match the fingerprinted claim");
    }
    if (stored.outcome === "IN_PROGRESS") return { kind: "IN_PROGRESS" };
    return { kind: "REPLAY", outcome: stored.outcome };
  }

  async complete(
    requestIdValue: string,
    fingerprintValue: string,
    outcome: NeedsChangesAuditTerminalOutcome,
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
          result.expectedHeadSha,
          result.expectedMainSha,
          result.observedHeadSha,
          result.observedMainSha,
          result.observedAt,
          result.reviewId,
          result.reviewUrl,
          result.submittedAt,
          completedAt,
        )
        .run();
      requireExactChange(update, "Needs changes success completion");
      return;
    }

    if (outcome.kind === "FAILED") {
      if (!storedFailureCodes.has(outcome.code)) {
        throw new D1NeedsChangesAuditError("failure outcome code is not persistable");
      }
      const update = await this.#database
        .prepare(COMPLETE_FAILED_SQL)
        .bind(requestId, fingerprint, outcome.code, completedAt)
        .run();
      requireExactChange(update, "Needs changes failed completion");
      return;
    }

    if (outcome.kind === "UNKNOWN" && outcome.code === "WRITE_OUTCOME_UNKNOWN") {
      const update = await this.#database
        .prepare(COMPLETE_UNKNOWN_SQL)
        .bind(requestId, fingerprint, completedAt)
        .run();
      requireExactChange(update, "Needs changes unknown completion");
      return;
    }

    throw new D1NeedsChangesAuditError("terminal outcome is unsupported");
  }
}
