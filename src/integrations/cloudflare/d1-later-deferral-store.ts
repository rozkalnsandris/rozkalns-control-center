import type { LaterDeferralEvidence } from "../../shared/later-decision.js";
import {
  LATER_ACTOR_MAX_BYTES,
  type LaterDecisionActor,
  type LaterDeferralClaimInput,
  type LaterDeferralClaimResult,
  type LaterDeferralReplaceInput,
  type LaterDeferralReplaceResult,
  type LaterDeferralStore,
  type PersistedLaterDeferral,
} from "../../shared/later-deferral-store.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

const FINGERPRINT_PATTERN = /^later-v1-[0-9a-f]{16}$/;
const IDENTIFIER_LIMIT = 256;

const INSERT_DEFERRAL_SQL = `
INSERT INTO later_deferrals (
  decision_id,
  schema_version,
  project_id,
  issue_number,
  pr_number,
  state_fingerprint,
  deferred_at,
  actor_subject,
  actor_email
) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(decision_id) DO NOTHING
`.trim();

const READ_DEFERRAL_SQL = `
SELECT
  decision_id,
  schema_version,
  project_id,
  issue_number,
  pr_number,
  state_fingerprint,
  deferred_at,
  actor_subject,
  actor_email
FROM later_deferrals
WHERE decision_id = ?1
LIMIT 1
`.trim();

const REPLACE_DEFERRAL_SQL = `
UPDATE later_deferrals
SET
  project_id = ?2,
  issue_number = ?3,
  pr_number = ?4,
  state_fingerprint = ?5,
  deferred_at = ?6,
  actor_subject = ?7,
  actor_email = ?8
WHERE
  decision_id = ?1
  AND project_id = ?9
  AND state_fingerprint = ?10
`.trim();

interface StoredLaterDeferralRow {
  readonly decision_id: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly issue_number: number | null;
  readonly pr_number: number | null;
  readonly state_fingerprint: string;
  readonly deferred_at: string;
  readonly actor_subject: string;
  readonly actor_email: string | null;
}

interface NormalizedClaim {
  readonly actor: LaterDecisionActor;
  readonly evidence: LaterDeferralEvidence;
}

export class D1LaterDeferralStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1LaterDeferralStoreError";
  }
}

function fail(message: string): never {
  throw new D1LaterDeferralStoreError(message);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_LIMIT ||
    hasControlCharacter(value)
  ) {
    fail(`${field} is malformed`);
  }
  return value;
}

function requireOptionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`${field} is malformed`);
  return Number(value);
}

function requireFingerprint(value: unknown, field: string): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    fail(`${field} is malformed`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} is malformed`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${field} must be an exact UTC ISO timestamp`);
  }
  return value;
}

function requireActorValue(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    new TextEncoder().encode(value).byteLength > LATER_ACTOR_MAX_BYTES
  ) {
    fail(`${field} is malformed`);
  }
  return value;
}

function requireActor(actor: LaterDecisionActor): LaterDecisionActor {
  if (!actor || typeof actor !== "object") fail("actor is malformed");
  return {
    subject: requireActorValue(actor.subject, "actor subject"),
    email: actor.email === null ? null : requireActorValue(actor.email, "actor email"),
  };
}

function requireEvidence(evidence: LaterDeferralEvidence): LaterDeferralEvidence {
  if (!evidence || typeof evidence !== "object" || evidence.schemaVersion !== 1) {
    fail("Later deferral evidence schema version is unsupported");
  }
  return {
    schemaVersion: 1,
    decisionId: requireIdentifier(evidence.decisionId, "decisionId"),
    projectId: requireIdentifier(evidence.projectId, "projectId"),
    issueNumber: requireOptionalPositiveInteger(evidence.issueNumber, "issueNumber"),
    prNumber: requireOptionalPositiveInteger(evidence.prNumber, "prNumber"),
    stateFingerprint: requireFingerprint(evidence.stateFingerprint, "stateFingerprint"),
    deferredAt: requireTimestamp(evidence.deferredAt, "deferredAt"),
  };
}

function normalizeClaim(input: LaterDeferralClaimInput): NormalizedClaim {
  if (!input || typeof input !== "object") fail("Later deferral claim is malformed");
  return {
    actor: requireActor(input.actor),
    evidence: requireEvidence(input.evidence),
  };
}

function requireSuccessfulResult<Row>(result: D1RunResultLike<Row>, operation: string): void {
  if (result.success !== true) fail(`D1 ${operation} did not report success`);
}

function requireClaimChangeCount(result: D1RunResultLike, operation: string): 0 | 1 {
  requireSuccessfulResult(result, operation);
  if (result.meta.changes !== 0 && result.meta.changes !== 1) {
    fail(`D1 ${operation} returned an unexpected change count`);
  }
  return result.meta.changes;
}

function parseStored(row: StoredLaterDeferralRow): PersistedLaterDeferral {
  if (!row || typeof row !== "object" || row.schema_version !== 1) {
    fail("stored Later deferral schema version is unsupported");
  }
  const evidence = requireEvidence({
    schemaVersion: 1,
    decisionId: row.decision_id,
    projectId: row.project_id,
    issueNumber: row.issue_number,
    prNumber: row.pr_number,
    stateFingerprint: row.state_fingerprint,
    deferredAt: row.deferred_at,
  });
  return {
    ...evidence,
    actor: requireActor({ subject: row.actor_subject, email: row.actor_email }),
  };
}

function sameFingerprintIdentity(
  stored: PersistedLaterDeferral,
  evidence: LaterDeferralEvidence,
): boolean {
  return (
    stored.decisionId === evidence.decisionId &&
    stored.projectId === evidence.projectId &&
    stored.issueNumber === evidence.issueNumber &&
    stored.prNumber === evidence.prNumber &&
    stored.stateFingerprint === evidence.stateFingerprint
  );
}

export class D1LaterDeferralStore implements LaterDeferralStore {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async claim(input: LaterDeferralClaimInput): Promise<LaterDeferralClaimResult> {
    const claim = normalizeClaim(input);
    const { actor, evidence } = claim;

    const insert = await this.#database
      .prepare(INSERT_DEFERRAL_SQL)
      .bind(
        evidence.decisionId,
        evidence.projectId,
        evidence.issueNumber,
        evidence.prNumber,
        evidence.stateFingerprint,
        evidence.deferredAt,
        actor.subject,
        actor.email,
      )
      .run();

    if (requireClaimChangeCount(insert, "Later deferral claim insert") === 1) {
      return { kind: "CLAIMED" };
    }

    const stored = await this.read(evidence.decisionId);
    if (stored === null) {
      fail("D1 Later deferral conflict could not be reconciled to one stored row");
    }
    if (stored.projectId !== evidence.projectId) {
      fail("D1 Later decision identity is already bound to a different project");
    }
    if (stored.stateFingerprint !== evidence.stateFingerprint) {
      return { kind: "CONFLICT" };
    }
    if (!sameFingerprintIdentity(stored, evidence)) {
      fail("D1 Later fingerprint collision does not match persisted decision evidence");
    }

    return { kind: "REPLAY" };
  }

  async read(decisionId: string): Promise<PersistedLaterDeferral | null> {
    const normalizedDecisionId = requireIdentifier(decisionId, "decisionId");
    const result = await this.#database
      .prepare(READ_DEFERRAL_SQL)
      .bind(normalizedDecisionId)
      .run<StoredLaterDeferralRow>();

    requireSuccessfulResult(result, "Later deferral read");
    if (result.results.length === 0) return null;
    if (result.results.length !== 1) {
      fail("D1 Later decision identity could not be uniquely proven");
    }
    return parseStored(result.results[0]);
  }

  async replace(input: LaterDeferralReplaceInput): Promise<LaterDeferralReplaceResult> {
    if (!input || typeof input !== "object") fail("Later deferral replacement is malformed");
    const expectedStateFingerprint = requireFingerprint(
      input.expectedStateFingerprint,
      "expectedStateFingerprint",
    );
    const claim = normalizeClaim(input.claim);
    const { actor, evidence } = claim;

    if (expectedStateFingerprint === evidence.stateFingerprint) {
      fail("Later deferral replacement must bind a materially changed fingerprint");
    }

    const update = await this.#database
      .prepare(REPLACE_DEFERRAL_SQL)
      .bind(
        evidence.decisionId,
        evidence.projectId,
        evidence.issueNumber,
        evidence.prNumber,
        evidence.stateFingerprint,
        evidence.deferredAt,
        actor.subject,
        actor.email,
        evidence.projectId,
        expectedStateFingerprint,
      )
      .run();

    if (requireClaimChangeCount(update, "Later deferral compare-and-swap replace") === 1) {
      return { kind: "REPLACED" };
    }

    const stored = await this.read(evidence.decisionId);
    if (stored === null) return { kind: "CONFLICT" };
    if (stored.projectId !== evidence.projectId) {
      fail("D1 Later replacement identity is bound to a different project");
    }
    if (stored.stateFingerprint !== evidence.stateFingerprint) {
      return { kind: "CONFLICT" };
    }
    if (!sameFingerprintIdentity(stored, evidence)) {
      fail("D1 Later replacement fingerprint collision does not match persisted evidence");
    }

    return { kind: "REPLAY" };
  }
}
