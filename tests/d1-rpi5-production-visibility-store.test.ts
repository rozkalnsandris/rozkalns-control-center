import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  D1Rpi5ProductionVisibilityStore,
  Rpi5ProductionVisibilityStoreError,
} from "../src/integrations/cloudflare/d1-rpi5-production-visibility-store.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";

const MAIN_SHA = "a".repeat(40);
const PRODUCTION_SHA = "b".repeat(40);
const OBSERVED_AT = "2026-09-08T17:30:00.000Z";
const STORED_AT = "2026-09-08T17:30:01.000Z";

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

type TestRow = Record<string, unknown>;
type TestResult = D1RunResultLike<TestRow>;
type TestStep = TestResult | Error;

function result(
  changes: number | undefined,
  results: readonly TestRow[] = [],
  success = true,
): TestResult {
  return {
    success,
    meta: changes === undefined ? {} : { changes },
    results,
  };
}

function fakeDatabase(...steps: readonly TestStep[]): {
  readonly database: D1DatabaseLike;
  readonly calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let nextStep = 0;

  const database: D1DatabaseLike = {
    prepare(query: string): D1PreparedStatementLike {
      let values: readonly unknown[] = [];
      const statement: D1PreparedStatementLike = {
        bind(...boundValues: readonly unknown[]): D1PreparedStatementLike {
          values = boundValues;
          return statement;
        },
        async run<Row = Record<string, unknown>>(): Promise<D1RunResultLike<Row>> {
          calls.push({ query, values });
          const step = steps[nextStep];
          nextStep += 1;
          if (!step) throw new Error("unexpected D1 call");
          if (step instanceof Error) throw step;
          return step as unknown as D1RunResultLike<Row>;
        },
      };
      return statement;
    },
  };

  return { database, calls };
}

function storedRow(overrides: Partial<TestRow> = {}): TestRow {
  return {
    project_id: VISIBILITY.projectId,
    repository: VISIBILITY.repository,
    main_sha: VISIBILITY.mainSha,
    production_sha: VISIBILITY.productionSha,
    deploy_impact: VISIBILITY.deployImpact,
    runtime: VISIBILITY.runtime,
    health: VISIBILITY.health,
    rollback: VISIBILITY.rollback,
    blocker_codes_json: JSON.stringify(VISIBILITY.blockerCodes),
    observed_at: VISIBILITY.observedAt,
    observed_at_ms: Date.parse(VISIBILITY.observedAt),
    production_adapter: VISIBILITY.productionAdapter,
    drift: VISIBILITY.drift,
    stored_at: STORED_AT,
    stored_at_ms: Date.parse(STORED_AT),
    ...overrides,
  };
}

function expectStoreError(
  code: Rpi5ProductionVisibilityStoreError["code"],
): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof Rpi5ProductionVisibilityStoreError && error.code === code;
}

test("projection store inserts only normalized fields and serializes blockers", async () => {
  const fake = fakeDatabase(result(1));
  const store = new D1Rpi5ProductionVisibilityStore(fake.database);

  assert.equal(await store.persist(VISIBILITY, STORED_AT), "STORED");
  assert.equal(fake.calls.length, 1);

  const call = fake.calls[0];
  assert.ok(call);
  assert.match(call.query, /^INSERT INTO rpi5_production_visibility/);
  assert.match(
    call.query,
    /WHERE rpi5_production_visibility\.observed_at_ms < excluded\.observed_at_ms/,
  );
  assert.deepEqual(call.values, [
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
    STORED_AT,
    Date.parse(STORED_AT),
  ]);
});

test("projection store reports equal or older observations as non-regressing no-ops", async () => {
  const older = {
    ...VISIBILITY,
    observedAt: "2026-09-08T17:29:00.000Z",
  };
  const fake = fakeDatabase(result(0), result(0));
  const store = new D1Rpi5ProductionVisibilityStore(fake.database);

  assert.equal(await store.persist(VISIBILITY, STORED_AT), "NOT_NEWER");
  assert.equal(await store.persist(older, STORED_AT), "NOT_NEWER");
  assert.equal(fake.calls.length, 2);
});

test("projection store fails closed on invalid input and malformed write results", async () => {
  const invalid = {
    ...VISIBILITY,
    drift: "IN_SYNC",
  };
  const unused = fakeDatabase(result(1));
  const invalidStore = new D1Rpi5ProductionVisibilityStore(unused.database);
  await assert.rejects(
    invalidStore.persist(invalid, STORED_AT),
    expectStoreError("INVALID_INPUT"),
  );
  assert.equal(unused.calls.length, 0);

  await assert.rejects(
    invalidStore.persist(VISIBILITY, "2026-09-08T17:29:59.000Z"),
    expectStoreError("INVALID_INPUT"),
  );
  assert.equal(unused.calls.length, 0);

  const extra = {
    ...VISIBILITY,
    rawPayload: "must-not-be-stored",
  };
  await assert.rejects(
    invalidStore.persist(extra, STORED_AT),
    expectStoreError("INVALID_INPUT"),
  );
  assert.equal(unused.calls.length, 0);

  for (const step of [
    result(undefined),
    result(2),
    result(1, [], false),
    new Error("D1 unavailable"),
  ]) {
    const fake = fakeDatabase(step);
    const store = new D1Rpi5ProductionVisibilityStore(fake.database);
    await assert.rejects(
      store.persist(VISIBILITY, STORED_AT),
      expectStoreError("D1_FAILURE"),
    );
  }
});

test("projection store reads one strict typed current row", async () => {
  const fake = fakeDatabase(result(0, [storedRow()]));
  const store = new D1Rpi5ProductionVisibilityStore(fake.database);

  const read = await store.read(VISIBILITY.projectId, VISIBILITY.repository);
  assert.deepEqual(read, {
    kind: "FOUND",
    visibility: VISIBILITY,
    storedAt: STORED_AT,
  });
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0]?.query ?? "", /LIMIT 2$/);
  assert.deepEqual(fake.calls[0]?.values, [VISIBILITY.projectId, VISIBILITY.repository]);
});

test("projection store returns NOT_FOUND only for an authoritative empty read", async () => {
  const fake = fakeDatabase(result(0, []));
  const store = new D1Rpi5ProductionVisibilityStore(fake.database);

  assert.deepEqual(await store.read(VISIBILITY.projectId, VISIBILITY.repository), {
    kind: "NOT_FOUND",
  });
});

test("projection store rejects malformed or ambiguous stored rows", async () => {
  const malformedRows: readonly TestRow[] = [
    storedRow({ blocker_codes_json: "not-json" }),
    storedRow({ drift: "IN_SYNC" }),
    storedRow({ observed_at_ms: Date.parse(VISIBILITY.observedAt) + 1 }),
    storedRow({ stored_at_ms: Date.parse(STORED_AT) + 1 }),
    storedRow({ project_id: "hermes-deals" }),
  ];

  for (const row of malformedRows) {
    const fake = fakeDatabase(result(0, [row]));
    const store = new D1Rpi5ProductionVisibilityStore(fake.database);
    await assert.rejects(
      store.read(VISIBILITY.projectId, VISIBILITY.repository),
      expectStoreError("INVALID_STORED_ROW"),
    );
  }

  const duplicate = fakeDatabase(result(0, [storedRow(), storedRow()]));
  await assert.rejects(
    new D1Rpi5ProductionVisibilityStore(duplicate.database).read(
      VISIBILITY.projectId,
      VISIBILITY.repository,
    ),
    expectStoreError("INVALID_STORED_ROW"),
  );
});

test("projection store rejects invalid read identity and D1 read failures", async () => {
  const unused = fakeDatabase(result(0, []));
  const store = new D1Rpi5ProductionVisibilityStore(unused.database);

  await assert.rejects(
    store.read("hermes-deals", VISIBILITY.repository),
    expectStoreError("INVALID_INPUT"),
  );
  assert.equal(unused.calls.length, 0);

  const failure = fakeDatabase(new Error("D1 unavailable"));
  await assert.rejects(
    new D1Rpi5ProductionVisibilityStore(failure.database).read(
      VISIBILITY.projectId,
      VISIBILITY.repository,
    ),
    expectStoreError("D1_FAILURE"),
  );

  const malformed = fakeDatabase(result(0, [], false));
  await assert.rejects(
    new D1Rpi5ProductionVisibilityStore(malformed.database).read(
      VISIBILITY.projectId,
      VISIBILITY.repository,
    ),
    expectStoreError("D1_FAILURE"),
  );
});

test("projection persistence source contains no transport, secret or host access path", () => {
  const source = readFileSync(
    "src/integrations/cloudflare/d1-rpi5-production-visibility-store.ts",
    "utf8",
  );
  const migration = readFileSync(
    "migrations/0012_rpi5_production_visibility_projection.sql",
    "utf8",
  );
  const combined = `${source}\n${migration}`;

  for (const forbidden of [
    /\bfetch\s*\(/i,
    /\bssh\b/i,
    /\bsudo\b/i,
    /\bprivate[_-]?key\b/i,
    /\bverification[_-]?key\b/i,
    /\bsignature\b/i,
    /\braw[_-]?payload\b/i,
    /\bsecret\b/i,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
});
