import { decisionDeepLinkPath } from "../../shared/decision-deep-link.js";
import {
  sanitizeNotificationText,
  type NotificationCandidate,
  type NotificationSignal,
} from "../../shared/notification-transition.js";
import type {
  NotificationTransitionClaim,
  NotificationTransitionClaimResult,
  NotificationTransitionStore,
} from "../../shared/notification-transition-store.js";
import type { D1DatabaseLike, D1RunResultLike } from "./d1-delivery-claim-store.js";

const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const transitionIdPattern = /^notification-v1-(needs-andris|ci-failed)-[0-9a-f]{16}$/;
const notificationSignals = new Set<NotificationSignal>(["NEEDS_ANDRIS", "CI_FAILED"]);

const DECISION_ID_MAX_BYTES = 512;
const PROJECT_ID_MAX_BYTES = 200;
const REFERENCE_MAX_LENGTH = 80;
const TITLE_MAX_LENGTH = 160;
const BODY_MAX_LENGTH = 280;
const DEEP_LINK_MAX_LENGTH = 1200;

const INSERT_TRANSITION_SQL = `
INSERT INTO notification_transitions (
  transition_id,
  schema_version,
  signal,
  decision_id,
  project_id,
  reference,
  title,
  body,
  deep_link_path,
  claimed_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
ON CONFLICT(transition_id) DO NOTHING
`.trim();

const READ_TRANSITION_SQL = `
SELECT
  transition_id,
  schema_version,
  signal,
  decision_id,
  project_id,
  reference,
  title,
  body,
  deep_link_path,
  claimed_at
FROM notification_transitions
WHERE transition_id = ?1
LIMIT 1
`.trim();

interface StoredNotificationTransitionRow {
  readonly transition_id: string;
  readonly schema_version: number;
  readonly signal: string;
  readonly decision_id: string;
  readonly project_id: string;
  readonly reference: string;
  readonly title: string;
  readonly body: string;
  readonly deep_link_path: string;
  readonly claimed_at: string;
}

interface NormalizedTransitionClaim {
  readonly candidate: NotificationCandidate;
  readonly claimedAt: string;
}

export class D1NotificationTransitionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1NotificationTransitionStoreError";
  }
}

function requireSuccessfulResult<Row>(result: D1RunResultLike<Row>, operation: string): void {
  if (result.success !== true) {
    throw new D1NotificationTransitionStoreError(`D1 ${operation} did not report success`);
  }
}

function requireUtcTimestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !utcTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new D1NotificationTransitionStoreError(`${field} must be a UTC ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function requireBoundedIdentifier(value: string, field: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new D1NotificationTransitionStoreError(`${field} is malformed`);
  }
  return value;
}

function requireSanitizedText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new D1NotificationTransitionStoreError(`${field} is malformed`);
  }
  const sanitized = sanitizeNotificationText(value, maxLength);
  if (sanitized.length === 0 || sanitized !== value) {
    throw new D1NotificationTransitionStoreError(`${field} is not bounded sanitized notification text`);
  }
  return value;
}

function requireSignal(value: string): NotificationSignal {
  if (!notificationSignals.has(value as NotificationSignal)) {
    throw new D1NotificationTransitionStoreError("notification signal is unsupported");
  }
  return value as NotificationSignal;
}

function requireTransitionId(value: string, signal: NotificationSignal): string {
  const expectedSignal = signal === "NEEDS_ANDRIS" ? "needs-andris" : "ci-failed";
  if (
    typeof value !== "string" ||
    !transitionIdPattern.test(value) ||
    !value.startsWith(`notification-v1-${expectedSignal}-`)
  ) {
    throw new D1NotificationTransitionStoreError("notification transition id is malformed");
  }
  return value;
}

function normalizeCandidate(candidate: NotificationCandidate): NotificationCandidate {
  if (!candidate || typeof candidate !== "object" || candidate.schemaVersion !== 1) {
    throw new D1NotificationTransitionStoreError("notification candidate schema version is unsupported");
  }

  const signal = requireSignal(candidate.signal);
  const decisionId = requireBoundedIdentifier(candidate.decisionId, "decisionId", DECISION_ID_MAX_BYTES);
  const projectId = requireBoundedIdentifier(candidate.projectId, "projectId", PROJECT_ID_MAX_BYTES);
  const transitionId = requireTransitionId(candidate.transitionId, signal);
  const reference = requireSanitizedText(candidate.reference, "reference", REFERENCE_MAX_LENGTH);
  const title = requireSanitizedText(candidate.title, "title", TITLE_MAX_LENGTH);
  const body = requireSanitizedText(candidate.body, "body", BODY_MAX_LENGTH);
  const expectedDeepLinkPath = decisionDeepLinkPath(decisionId);

  if (
    typeof candidate.deepLinkPath !== "string" ||
    candidate.deepLinkPath !== expectedDeepLinkPath ||
    candidate.deepLinkPath.length > DEEP_LINK_MAX_LENGTH
  ) {
    throw new D1NotificationTransitionStoreError("notification deep link does not match decision identity");
  }

  return {
    schemaVersion: 1,
    signal,
    transitionId,
    decisionId,
    projectId,
    reference,
    title,
    body,
    deepLinkPath: expectedDeepLinkPath,
  };
}

function normalizeClaim(input: NotificationTransitionClaim): NormalizedTransitionClaim {
  if (!input || typeof input !== "object") {
    throw new D1NotificationTransitionStoreError("notification transition claim is malformed");
  }
  return {
    candidate: normalizeCandidate(input.candidate),
    claimedAt: requireUtcTimestamp(input.claimedAt, "claimedAt"),
  };
}

function parseStoredTransition(row: StoredNotificationTransitionRow): NormalizedTransitionClaim {
  if (!row || typeof row !== "object" || row.schema_version !== 1) {
    throw new D1NotificationTransitionStoreError("stored notification schema version is unsupported");
  }

  return {
    candidate: normalizeCandidate({
      schemaVersion: 1,
      signal: requireSignal(row.signal),
      transitionId: row.transition_id,
      decisionId: row.decision_id,
      projectId: row.project_id,
      reference: row.reference,
      title: row.title,
      body: row.body,
      deepLinkPath: row.deep_link_path,
    }),
    claimedAt: requireUtcTimestamp(row.claimed_at, "stored claimedAt"),
  };
}

function sameCandidate(left: NotificationCandidate, right: NotificationCandidate): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.signal === right.signal &&
    left.transitionId === right.transitionId &&
    left.decisionId === right.decisionId &&
    left.projectId === right.projectId &&
    left.reference === right.reference &&
    left.title === right.title &&
    left.body === right.body &&
    left.deepLinkPath === right.deepLinkPath
  );
}

export class D1NotificationTransitionStore implements NotificationTransitionStore {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async claim(input: NotificationTransitionClaim): Promise<NotificationTransitionClaimResult> {
    const { candidate, claimedAt } = normalizeClaim(input);

    const insert = await this.#database
      .prepare(INSERT_TRANSITION_SQL)
      .bind(
        candidate.transitionId,
        candidate.schemaVersion,
        candidate.signal,
        candidate.decisionId,
        candidate.projectId,
        candidate.reference,
        candidate.title,
        candidate.body,
        candidate.deepLinkPath,
        claimedAt,
      )
      .run();

    requireSuccessfulResult(insert, "notification transition claim insert");
    if (insert.meta.changes === 1) return { kind: "CLAIMED" };
    if (insert.meta.changes !== 0) {
      throw new D1NotificationTransitionStoreError(
        "D1 notification transition claim returned an unexpected change count",
      );
    }

    const existing = await this.#database
      .prepare(READ_TRANSITION_SQL)
      .bind(candidate.transitionId)
      .run<StoredNotificationTransitionRow>();

    requireSuccessfulResult(existing, "notification transition read");
    if (existing.results.length !== 1) {
      throw new D1NotificationTransitionStoreError(
        "D1 notification transition identity could not be uniquely proven",
      );
    }

    const stored = parseStoredTransition(existing.results[0]);
    if (!sameCandidate(stored.candidate, candidate)) {
      throw new D1NotificationTransitionStoreError(
        "D1 duplicate transition id does not match the notification candidate",
      );
    }

    return { kind: "DUPLICATE" };
  }
}
