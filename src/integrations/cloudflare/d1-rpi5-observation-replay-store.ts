const replayKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/;

const CLAIM_REPLAY_SQL = `
INSERT INTO rpi5_observation_replay_claims (
  replay_key,
  replay_expires_at_ms,
  claimed_at_ms
) VALUES (?1, ?2, ?3)
ON CONFLICT(replay_key) DO UPDATE SET
  replay_expires_at_ms = excluded.replay_expires_at_ms,
  claimed_at_ms = excluded.claimed_at_ms
WHERE rpi5_observation_replay_claims.replay_expires_at_ms <= excluded.claimed_at_ms
`.trim();

export type Rpi5ObservationReplayClaimErrorCode = "INVALID_INPUT" | "ACTIVE_REPLAY" | "D1_FAILURE";

export class Rpi5ObservationReplayClaimError extends Error {
  readonly code: Rpi5ObservationReplayClaimErrorCode;

  constructor(code: Rpi5ObservationReplayClaimErrorCode) {
    super("RPi5 observation replay claim failed closed");
    this.name = "Rpi5ObservationReplayClaimError";
    this.code = code;
  }
}

export interface Rpi5ObservationReplayClaimInput {
  readonly replayKey: string;
  readonly replayExpiresAt: string;
  readonly claimedAt: string;
}

export interface Rpi5ObservationReplayD1RunMetaLike {
  readonly changes?: number;
}

export interface Rpi5ObservationReplayD1RunResultLike {
  readonly success: boolean;
  readonly meta?: Rpi5ObservationReplayD1RunMetaLike;
}

export interface Rpi5ObservationReplayD1PreparedStatementLike {
  bind(...values: readonly unknown[]): Rpi5ObservationReplayD1PreparedStatementLike;
  run(): Promise<Rpi5ObservationReplayD1RunResultLike>;
}

export interface Rpi5ObservationReplayD1DatabaseLike {
  prepare(query: string): Rpi5ObservationReplayD1PreparedStatementLike;
}

function fail(code: Rpi5ObservationReplayClaimErrorCode): never {
  throw new Rpi5ObservationReplayClaimError(code);
}

function requireReplayKey(value: unknown): string {
  if (typeof value !== "string" || !replayKeyPattern.test(value)) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireCanonicalTimestamp(value: unknown): number {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    new Date(timestamp).toISOString() !== value
  ) {
    fail("INVALID_INPUT");
  }
  return timestamp;
}

async function runAtomicClaim(
  database: Rpi5ObservationReplayD1DatabaseLike,
  replayKey: string,
  replayExpiresAtMs: number,
  claimedAtMs: number,
): Promise<Rpi5ObservationReplayD1RunResultLike> {
  try {
    return await database
      .prepare(CLAIM_REPLAY_SQL)
      .bind(replayKey, replayExpiresAtMs, claimedAtMs)
      .run();
  } catch {
    fail("D1_FAILURE");
  }
}

export async function claimRpi5ObservationReplay(
  database: Rpi5ObservationReplayD1DatabaseLike,
  input: Rpi5ObservationReplayClaimInput,
): Promise<void> {
  const replayKey = requireReplayKey(input.replayKey);
  const replayExpiresAtMs = requireCanonicalTimestamp(input.replayExpiresAt);
  const claimedAtMs = requireCanonicalTimestamp(input.claimedAt);

  if (replayExpiresAtMs <= claimedAtMs) fail("INVALID_INPUT");

  const result = await runAtomicClaim(database, replayKey, replayExpiresAtMs, claimedAtMs);
  if (result.success !== true) fail("D1_FAILURE");

  if (result.meta?.changes === 1) return;
  if (result.meta?.changes === 0) fail("ACTIVE_REPLAY");
  fail("D1_FAILURE");
}
