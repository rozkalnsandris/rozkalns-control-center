import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  D1Rpi5ObservationAcceptanceStore,
  Rpi5ObservationAcceptanceError,
  type Rpi5ObservationAcceptanceD1DatabaseLike,
} from "../src/integrations/cloudflare/d1-rpi5-observation-acceptance-store.js";
import type {
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";

const MAIN_SHA = "a".repeat(40);
const PRODUCTION_SHA = "b".repeat(40);
const OBSERVED_AT = "2026-09-08T17:30:00.000Z";
const ACCEPTED_AT = "2026-09-08T17:30:01.000Z";
const REPLAY_EXPIRES_AT = "2026-09-08T17:35:00.000Z";
const REPLAY_KEY = "phase5-key:550e8400-e29b-41d4-a716-446655440000";
const CLAIM_TOKEN = "c".repeat(32);

const VISIBILITY = {
  projectId: "hermes-tech",
  repository: "rozkalnsandris/hermes-tech",
  mainSha: MAIN_SHA,
  productionSha: PRODUCTION_SHA,
  deployImpact: "AUTO_DEPLOY_SAFE",
  runtime: "HEALTHY",
  health: "PASS",
  rollback: "AVAILABLE",
  blockerCodes: ["PRODUCTION_SHA_DRIFT"],
  observedAt: OBSERVED_AT,
  productionAdapter: "rpi5",
  drift: "DRIFTED",
} as const;

interface QueryCall {
  readonly query: string;
  readonly values: readonly unknown[];
}

type BatchStep = D1RunResultLike[] | Error;

function result(changes: number | undefined, success = true): D1RunResultLike {
  return {
    success,
    meta: changes === undefined ? {} : { changes },
    results: [],
  };
}

function fakeDatabase(...steps: readonly BatchStep[]): {
  readonly database: Rpi5ObservationAcceptanceD1DatabaseLike;
  readonly batches: QueryCall[][];
  readonly runCalls: number;
} {
  const records = new Map<D1PreparedStatementLike, QueryCall>();
  const batches: QueryCall[][] = [];
  let nextStep = 0;
  let runCalls = 0;

  const database: Rpi5ObservationAcceptanceD1DatabaseLike = {
    prepare(query: string): D1PreparedStatementLike {
      let values: readonly unknown[] = [];
      const statement: D1PreparedStatementLike = {
        bind(...boundValues: readonly unknown[]): D1PreparedStatementLike {
          values = boundValues;
          records.set(statement, { query, values });
          return statement;
        },
        async run<Row = Record<string, unknown>>(): Promise<D1RunResultLike<Row>> {
          runCalls += 1;
          throw new Error("atomic acceptance must use batch, not run");
        },
      };
      records.set(statement, { query, values });
      return statement;
    },
    async batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]> {
      batches.push(
        statements.map((statement) => {
          const record = records.get(statement);
          if (!record) throw new Error("unknown prepared statement");
          return record;
        }),
      );
      const step = steps[nextStep];
      nextStep += 1;
      if (!step) throw new Error("unexpected D1 batch");
      if (step instanceof Error) throw step;
      return step;
    },
  };

  return {
    database,
    batches,
    get runCalls() {
      return runCalls;
    },
  };
}

function input(overrides: Partial<{
  replayKey: unknown;
  replayExpiresAt: unknown;
  visibility: unknown;
  acceptedAt: unknown;
}> = {}) {
  return {
    replayKey: REPLAY_KEY,
    replayExpiresAt: REPLAY_EXPIRES_AT,
    visibility: VISIBILITY,
    acceptedAt: ACCEPTED_AT,
    ...overrides,
  };
}

function expectAcceptanceError(
  code: Rpi5ObservationAcceptanceError["code"],
): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof Rpi5ObservationAcceptanceError && error.code === code;
}

test("atomic acceptance stores replay claim and newer projection in one guarded batch", async () => {
  const fake = fakeDatabase([result(1), result(1)]);
  const store = new D1Rpi5ObservationAcceptanceStore(fake.database, () => CLAIM_TOKEN);

  assert.equal(await store.accept(input()), "STORED");
  assert.equal(fake.batches.length, 1);
  assert.equal(fake.runCalls, 0);
  assert.equal(fake.batches[0]?.length, 2);

  const claim = fake.batches[0]?.[0];
  const projection = fake.batches[0]?.[1];
  assert.ok(claim);
  assert.ok(projection);

  assert.match(claim.query, /^INSERT INTO rpi5_observation_replay_claims/);
  assert.match(claim.query, /claim_token = excluded\.claim_token/);
  assert.deepEqual(claim.values, [
    REPLAY_KEY,
    Date.parse(REPLAY_EXPIRES_AT),
    Date.parse(ACCEPTED_AT),
    CLAIM_TOKEN,
  ]);

  assert.match(projection.query, /^INSERT INTO rpi5_production_visibility/);
  assert.match(projection.query, /WHERE EXISTS \(/);
  assert.match(projection.query, /claim_token = \?4/);
  assert.match(
    projection.query,
    /WHERE rpi5_production_visibility\.observed_at_ms < excluded\.observed_at_ms/,
  );
  assert.deepEqual(projection.values, [
    REPLAY_KEY,
    Date.parse(REPLAY_EXPIRES_AT),
    Date.parse(ACCEPTED_AT),
    CLAIM_TOKEN,
    VISIBILITY.projectId,
    VISIBILITY.repository,
    VISIBILITY.mainSha,
    VISIBILITY.productionSha,
    VISIBILITY.deployImpact,
    VISIBILITY.runtime,
    VISIBILITY.health,
    VISIBILITY.rollback,
    JSON.stringify(VISIBILITY.blockerCodes),
    VISIBILITY.observedAt,
    Date.parse(VISIBILITY.observedAt),
    VISIBILITY.productionAdapter,
    VISIBILITY.drift,
    ACCEPTED_AT,
    Date.parse(ACCEPTED_AT),
  ]);
});

test("atomic acceptance consumes valid replay identity without regressing a newer projection", async () => {
  const fake = fakeDatabase([result(1), result(0)]);
  const store = new D1Rpi5ObservationAcceptanceStore(fake.database, () => CLAIM_TOKEN);

  assert.equal(await store.accept(input()), "NOT_NEWER");
  assert.equal(fake.batches.length, 1);
});

test("active replay cannot update projection", async () => {
  const fake = fakeDatabase([result(0), result(0)]);
  const store = new D1Rpi5ObservationAcceptanceStore(fake.database, () => CLAIM_TOKEN);

  await assert.rejects(store.accept(input()), expectAcceptanceError("ACTIVE_REPLAY"));
  assert.equal(fake.batches.length, 1);

  const projection = fake.batches[0]?.[1];
  assert.ok(projection);
  assert.match(projection.query, /claim_token = \?4/);
});

test("claim/projection result mismatch fails closed", async () => {
  const fake = fakeDatabase([result(0), result(1)]);
  const store = new D1Rpi5ObservationAcceptanceStore(fake.database, () => CLAIM_TOKEN);

  await assert.rejects(store.accept(input()), expectAcceptanceError("D1_FAILURE"));
});

test("atomic acceptance rejects invalid input before D1 batch", async () => {
  const invalidInputs = [
    input({ replayKey: "bad key" }),
    input({ replayExpiresAt: ACCEPTED_AT }),
    input({ acceptedAt: "2026-09-08T17:29:59.000Z" }),
    input({ visibility: { ...VISIBILITY, drift: "IN_SYNC" } }),
    input({ visibility: { ...VISIBILITY, projectId: "hermes-deals" } }),
    input({ visibility: { ...VISIBILITY, rawPayload: "forbidden" } }),
  ];

  for (const candidate of invalidInputs) {
    const fake = fakeDatabase([result(1), result(1)]);
    const store = new D1Rpi5ObservationAcceptanceStore(fake.database, () => CLAIM_TOKEN);
    await assert.rejects(store.accept(candidate), expectAcceptanceError("INVALID_INPUT"));
    assert.equal(fake.batches.length, 0);
  }
});

test("invalid claim-token generation fails closed before D1 batch", async () => {
  for (const factory of [
    () => "not-hex",
    () => {
      throw new Error("entropy unavailable");
    },
  ]) {
    const fake = fakeDatabase([result(1), result(1)]);
    const store = new D1Rpi5ObservationAcceptanceStore(fake.database, factory);
    await assert.rejects(store.accept(input()), expectAcceptanceError("D1_FAILURE"));
    assert.equal(fake.batches.length, 0);
  }
});

test("malformed, failed or rejected D1 batches fail closed", async () => {
  const steps: readonly BatchStep[] = [
    [result(1)],
    [result(undefined), result(1)],
    [result(2), result(1)],
    [result(1, false), result(1)],
    [result(1), result(undefined)],
    [result(1), result(2)],
    [result(1), result(1, false)],
    new Error("D1 batch unavailable"),
  ];

  for (const step of steps) {
    const fake = fakeDatabase(step);
    const store = new D1Rpi5ObservationAcceptanceStore(fake.database, () => CLAIM_TOKEN);
    await assert.rejects(store.accept(input()), expectAcceptanceError("D1_FAILURE"));
  }
});

test("0013 migration keeps legacy rows valid and bounds new claim tokens", () => {
  const migration = readFileSync(
    "migrations/0013_rpi5_observation_atomic_acceptance.sql",
    "utf8",
  );

  assert.match(migration, /ADD COLUMN claim_token TEXT NOT NULL DEFAULT ''/);
  assert.match(migration, /claim_token = ''/);
  assert.match(migration, /length\(claim_token\) = 32/);
  assert.match(migration, /claim_token NOT GLOB '\*\[\^0-9a-f\]\*'/);
});

test("atomic acceptance source contains no transport, secret or host access path", () => {
  const source = readFileSync(
    "src/integrations/cloudflare/d1-rpi5-observation-acceptance-store.ts",
    "utf8",
  );
  const migration = readFileSync(
    "migrations/0013_rpi5_observation_atomic_acceptance.sql",
    "utf8",
  );
  const combined = `${source}\n${migration}`;

  for (const forbidden of [
    /\bfetch\s*\(/i,
    /\bssh\b/i,
    /\bsudo\b/i,
    /\bprivate[_-]?key\b/i,
    /\bverification[_-]?key\b/i,
    /\braw[_-]?payload\b/i,
    /\bsecret\b/i,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
});
