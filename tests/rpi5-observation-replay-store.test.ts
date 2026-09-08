import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  claimRpi5ObservationReplay,
  Rpi5ObservationReplayClaimError,
  type Rpi5ObservationReplayD1DatabaseLike,
  type Rpi5ObservationReplayD1PreparedStatementLike,
  type Rpi5ObservationReplayD1RunResultLike,
} from "../src/integrations/cloudflare/d1-rpi5-observation-replay-store.js";

const REPLAY_KEY = "rpi5-prod-2026-09:123e4567-e89b-42d3-a456-426614174000";
const CLAIMED_AT = "2026-09-08T07:34:00.000Z";
const EXPIRES_AT = "2026-09-08T07:35:00.000Z";

function replayError(code: Rpi5ObservationReplayClaimError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Rpi5ObservationReplayClaimError && error.code === code;
}

class FakeStatement implements Rpi5ObservationReplayD1PreparedStatementLike {
  boundValues: readonly unknown[] = [];
  runs = 0;

  constructor(private readonly outcome: Rpi5ObservationReplayD1RunResultLike | Error) {}

  bind(...values: readonly unknown[]): Rpi5ObservationReplayD1PreparedStatementLike {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<Rpi5ObservationReplayD1RunResultLike> {
    this.runs += 1;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

class FakeDatabase implements Rpi5ObservationReplayD1DatabaseLike {
  readonly preparedSql: string[] = [];

  constructor(readonly statement: FakeStatement) {}

  prepare(query: string): Rpi5ObservationReplayD1PreparedStatementLike {
    this.preparedSql.push(query);
    return this.statement;
  }
}

function input(overrides: Partial<{ replayKey: string; replayExpiresAt: string; claimedAt: string }> = {}) {
  return {
    replayKey: REPLAY_KEY,
    replayExpiresAt: EXPIRES_AT,
    claimedAt: CLAIMED_AT,
    ...overrides,
  };
}

function successfulDatabase(changes: number): FakeDatabase {
  return new FakeDatabase(new FakeStatement({ success: true, meta: { changes } }));
}

test("migration defines durable replay identity and expiry index without payload storage", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "migrations/0011_rpi5_observation_replay_claims.sql"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS rpi5_observation_replay_claims/);
  assert.match(migration, /replay_key TEXT PRIMARY KEY/);
  assert.match(migration, /replay_expires_at_ms INTEGER NOT NULL/);
  assert.match(migration, /claimed_at_ms INTEGER NOT NULL/);
  assert.match(migration, /CHECK \(replay_expires_at_ms > claimed_at_ms\)/);
  assert.match(migration, /idx_rpi5_observation_replay_claims_expires_at_ms/);
  assert.doesNotMatch(migration, /payload|signature|private_key|secret|token/i);
});

test("claims a new replay identity with canonical millisecond timestamps", async () => {
  const database = successfulDatabase(1);

  await claimRpi5ObservationReplay(database, input());

  assert.equal(database.preparedSql.length, 1);
  assert.deepEqual(database.statement.boundValues, [REPLAY_KEY, Date.parse(EXPIRES_AT), Date.parse(CLAIMED_AT)]);
  assert.equal(database.statement.runs, 1);
});

test("atomic claim SQL only replaces a replay identity after its stored expiry", async () => {
  const database = successfulDatabase(1);

  await claimRpi5ObservationReplay(database, input());

  const sql = database.preparedSql[0];
  assert.match(sql, /ON CONFLICT\(replay_key\) DO UPDATE SET/);
  assert.match(
    sql,
    /WHERE rpi5_observation_replay_claims\.replay_expires_at_ms <= excluded\.claimed_at_ms/,
  );
  assert.equal(database.statement.runs, 1, "claim/reclaim must use one D1 statement");
});

test("fails closed when the replay identity is still active", async () => {
  const database = successfulDatabase(0);

  await assert.rejects(claimRpi5ObservationReplay(database, input()), replayError("ACTIVE_REPLAY"));
  assert.equal(database.statement.runs, 1);
});

test("rejects malformed replay inputs before preparing D1 mutation", async () => {
  const invalidInputs = [
    input({ replayKey: "bad replay key" }),
    input({ replayExpiresAt: "not-a-timestamp" }),
    input({ claimedAt: "2026-09-08T07:34:00Z" }),
    input({ replayExpiresAt: CLAIMED_AT }),
    input({ replayExpiresAt: "2026-09-08T07:33:59.999Z" }),
  ];

  for (const candidate of invalidInputs) {
    const database = successfulDatabase(1);
    await assert.rejects(claimRpi5ObservationReplay(database, candidate), replayError("INVALID_INPUT"));
    assert.equal(database.preparedSql.length, 0);
    assert.equal(database.statement.runs, 0);
  }
});

test("fails closed on unsuccessful or ambiguous D1 outcomes", async () => {
  const outcomes: Array<Rpi5ObservationReplayD1RunResultLike | Error> = [
    { success: false, meta: { changes: 1 } },
    { success: true },
    { success: true, meta: {} },
    { success: true, meta: { changes: 2 } },
    new Error("transient D1 failure"),
  ];

  for (const outcome of outcomes) {
    const database = new FakeDatabase(new FakeStatement(outcome));
    await assert.rejects(claimRpi5ObservationReplay(database, input()), replayError("D1_FAILURE"));
  }
});

test("replay persistence source remains unwired from Worker runtime and live bindings", () => {
  const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");

  assert.equal(workerIndex.includes("d1-rpi5-observation-replay-store"), false);
  assert.equal(wranglerConfig.includes("RPI5_OBSERVATION_REPLAY_STORE"), false);
});
