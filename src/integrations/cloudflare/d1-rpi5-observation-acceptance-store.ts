import {
  normalizeProductionVisibility,
  type ProductionVisibilityEvidence,
  type ProductionVisibilityReadModel,
} from "../../shared/production-visibility.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import type {
  D1PreparedStatementLike,
  D1RunResultLike,
} from "./d1-delivery-claim-store.js";

const replayKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/;
const claimTokenPattern = /^[0-9a-f]{32}$/;
const MAX_BLOCKER_CODES_JSON_BYTES = 4096;

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
const VISIBILITY_FIELD_SET = new Set<string>(VISIBILITY_FIELDS);

const CLAIM_REPLAY_SQL = `
INSERT INTO rpi5_observation_replay_claims (
  replay_key,
  replay_expires_at_ms,
  claimed_at_ms,
  claim_token
) VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(replay_key) DO UPDATE SET
  replay_expires_at_ms = excluded.replay_expires_at_ms,
  claimed_at_ms = excluded.claimed_at_ms,
  claim_token = excluded.claim_token
WHERE rpi5_observation_replay_claims.replay_expires_at_ms <= excluded.claimed_at_ms
`.trim();

const WRITE_VISIBILITY_IF_CLAIMED_SQL = `
INSERT INTO rpi5_production_visibility (
  project_id,
  repository,
  main_sha,
  production_sha,
  deploy_impact,
  runtime,
  health,
  rollback,
  blocker_codes_json,
  observed_at,
  observed_at_ms,
  production_adapter,
  drift,
  stored_at,
  stored_at_ms
)
SELECT
  ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
WHERE EXISTS (
  SELECT 1
  FROM rpi5_observation_replay_claims
  WHERE replay_key = ?1
    AND replay_expires_at_ms = ?2
    AND claimed_at_ms = ?3
    AND claim_token = ?4
)
ON CONFLICT(project_id) DO UPDATE SET
  repository = excluded.repository,
  main_sha = excluded.main_sha,
  production_sha = excluded.production_sha,
  deploy_impact = excluded.deploy_impact,
  runtime = excluded.runtime,
  health = excluded.health,
  rollback = excluded.rollback,
  blocker_codes_json = excluded.blocker_codes_json,
  observed_at = excluded.observed_at,
  observed_at_ms = excluded.observed_at_ms,
  production_adapter = excluded.production_adapter,
  drift = excluded.drift,
  stored_at = excluded.stored_at,
  stored_at_ms = excluded.stored_at_ms
WHERE rpi5_production_visibility.observed_at_ms < excluded.observed_at_ms
`.trim();

export type Rpi5ObservationAcceptanceResult = "STORED" | "NOT_NEWER";
export type Rpi5ObservationAcceptanceErrorCode =
  | "INVALID_INPUT"
  | "ACTIVE_REPLAY"
  | "D1_FAILURE";

export class Rpi5ObservationAcceptanceError extends Error {
  readonly code: Rpi5ObservationAcceptanceErrorCode;

  constructor(code: Rpi5ObservationAcceptanceErrorCode) {
    super("RPi5 observation atomic acceptance failed closed");
    this.name = "Rpi5ObservationAcceptanceError";
    this.code = code;
  }
}

export interface Rpi5ObservationAcceptanceInput {
  readonly replayKey: unknown;
  readonly replayExpiresAt: unknown;
  readonly visibility: unknown;
  readonly acceptedAt: unknown;
}

export interface Rpi5ObservationAcceptanceD1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]>;
}

export type Rpi5ObservationClaimTokenFactory = () => string;

function fail(code: Rpi5ObservationAcceptanceErrorCode): never {
  throw new Rpi5ObservationAcceptanceError(code);
}

function requireCanonicalTimestamp(
  value: unknown,
): { readonly value: string; readonly milliseconds: number } {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail("INVALID_INPUT");
  }
  return { value, milliseconds };
}

function requireReplayKey(value: unknown): string {
  if (typeof value !== "string" || !replayKeyPattern.test(value)) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireExactPlainObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_INPUT");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_INPUT");

  const record = input as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !VISIBILITY_FIELD_SET.has(key)) fail("INVALID_INPUT");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail("INVALID_INPUT");
  }
  for (const field of VISIBILITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) fail("INVALID_INPUT");
  }
  return record;
}

function normalizeVisibilityInput(input: unknown): ProductionVisibilityReadModel {
  const record = requireExactPlainObject(input);
  const evidence: ProductionVisibilityEvidence = {
    projectId: record.projectId as string,
    repository: record.repository as string,
    mainSha: record.mainSha as string,
    productionSha: record.productionSha as string,
    deployImpact: record.deployImpact as ProductionVisibilityEvidence["deployImpact"],
    runtime: record.runtime as ProductionVisibilityEvidence["runtime"],
    health: record.health as ProductionVisibilityEvidence["health"],
    rollback: record.rollback as ProductionVisibilityEvidence["rollback"],
    blockerCodes: record.blockerCodes as readonly string[],
    observedAt: record.observedAt as string,
  };

  let normalized: ProductionVisibilityReadModel;
  try {
    normalized = normalizeProductionVisibility(evidence, evidence.observedAt);
  } catch {
    fail("INVALID_INPUT");
  }

  if (
    record.productionAdapter !== normalized.productionAdapter ||
    record.drift !== normalized.drift
  ) {
    fail("INVALID_INPUT");
  }

  let policy;
  try {
    policy = requireManagedProjectPolicy(normalized.repository);
  } catch {
    fail("INVALID_INPUT");
  }
  if (
    policy.id !== normalized.projectId ||
    policy.repository !== normalized.repository ||
    policy.productionAdapter !== "rpi5"
  ) {
    fail("INVALID_INPUT");
  }
  return normalized;
}

function defaultClaimTokenFactory(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function requireClaimToken(factory: Rpi5ObservationClaimTokenFactory): string {
  let token: unknown;
  try {
    token = factory();
  } catch {
    fail("D1_FAILURE");
  }
  if (typeof token !== "string" || !claimTokenPattern.test(token)) {
    fail("D1_FAILURE");
  }
  return token;
}

function requireBatchResult(result: D1RunResultLike | undefined): number {
  const changes = result?.meta?.changes;
  if (
    !result ||
    result.success !== true ||
    typeof changes !== "number" ||
    !Number.isSafeInteger(changes)
  ) {
    fail("D1_FAILURE");
  }
  if (changes !== 0 && changes !== 1) fail("D1_FAILURE");
  return changes;
}

async function runAtomicBatch(
  database: Rpi5ObservationAcceptanceD1DatabaseLike,
  claimValues: readonly unknown[],
  projectionValues: readonly unknown[],
): Promise<readonly D1RunResultLike[]> {
  try {
    const claim = database.prepare(CLAIM_REPLAY_SQL).bind(...claimValues);
    const projection = database
      .prepare(WRITE_VISIBILITY_IF_CLAIMED_SQL)
      .bind(...projectionValues);
    return await database.batch([claim, projection]);
  } catch {
    fail("D1_FAILURE");
  }
}

/**
 * Atomically couples the replay claim and current production-visibility projection.
 *
 * The per-attempt claim token is generated inside this boundary and written only when
 * the replay row is inserted or an expired row is reclaimed. The projection statement
 * is guarded by that exact token, so an active replay cannot alter projection state.
 * Cloudflare D1 batch execution provides the transaction boundary: if the projection
 * statement fails, the claim statement is rolled back with the batch.
 *
 * This primitive accepts only already-authenticated, already-normalized visibility.
 * It does not verify signatures, parse raw payloads, provision keys, enable a Worker
 * route or perform any remote migration/deploy operation by itself.
 */
export class D1Rpi5ObservationAcceptanceStore {
  constructor(
    private readonly database: Rpi5ObservationAcceptanceD1DatabaseLike,
    private readonly claimTokenFactory: Rpi5ObservationClaimTokenFactory = defaultClaimTokenFactory,
  ) {}

  async accept(input: Rpi5ObservationAcceptanceInput): Promise<Rpi5ObservationAcceptanceResult> {
    const replayKey = requireReplayKey(input.replayKey);
    const replayExpiresAt = requireCanonicalTimestamp(input.replayExpiresAt);
    const visibility = normalizeVisibilityInput(input.visibility);
    const observedAt = requireCanonicalTimestamp(visibility.observedAt);
    const acceptedAt = requireCanonicalTimestamp(input.acceptedAt);

    if (
      replayExpiresAt.milliseconds <= acceptedAt.milliseconds ||
      acceptedAt.milliseconds < observedAt.milliseconds
    ) {
      fail("INVALID_INPUT");
    }

    const blockerCodesJson = JSON.stringify(visibility.blockerCodes);
    if (new TextEncoder().encode(blockerCodesJson).byteLength > MAX_BLOCKER_CODES_JSON_BYTES) {
      fail("INVALID_INPUT");
    }

    const claimToken = requireClaimToken(this.claimTokenFactory);
    const claimValues = [
      replayKey,
      replayExpiresAt.milliseconds,
      acceptedAt.milliseconds,
      claimToken,
    ] as const;
    const projectionValues = [
      replayKey,
      replayExpiresAt.milliseconds,
      acceptedAt.milliseconds,
      claimToken,
      visibility.projectId,
      visibility.repository,
      visibility.mainSha,
      visibility.productionSha,
      visibility.deployImpact,
      visibility.runtime,
      visibility.health,
      visibility.rollback,
      blockerCodesJson,
      observedAt.value,
      observedAt.milliseconds,
      visibility.productionAdapter,
      visibility.drift,
      acceptedAt.value,
      acceptedAt.milliseconds,
    ] as const;

    const results = await runAtomicBatch(this.database, claimValues, projectionValues);
    if (!Array.isArray(results) || results.length !== 2) fail("D1_FAILURE");

    const claimChanges = requireBatchResult(results[0]);
    const projectionChanges = requireBatchResult(results[1]);

    if (claimChanges === 0) {
      if (projectionChanges !== 0) fail("D1_FAILURE");
      fail("ACTIVE_REPLAY");
    }

    if (projectionChanges === 1) return "STORED";
    return "NOT_NEWER";
  }
}
