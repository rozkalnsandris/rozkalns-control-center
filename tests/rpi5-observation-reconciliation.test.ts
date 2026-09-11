import assert from "node:assert/strict";
import test from "node:test";

import {
  D1Rpi5ObservationReconciliationReader,
  reconcileRpi5Observation,
  type Rpi5ObservationReconciliationD1DatabaseLike,
  type Rpi5ObservationReconciliationD1PreparedStatementLike,
  type Rpi5ObservationReconciliationD1RunResultLike,
  type Rpi5ObservationReconciliationReader,
  type Rpi5ObservationReconciliationReadResult,
} from "../src/integrations/cloudflare/rpi5-observation-reconciliation.js";

const CONTROL_SHA = "a".repeat(40);
const PROJECT_MAIN_SHA = "b".repeat(40);
const PRODUCTION_SHA = "c".repeat(40);
const WORKER_DEPLOYMENT_ID = "550e8400-e29b-41d4-a716-446655440001";
const WORKER_VERSION_ID = "550e8400-e29b-41d4-a716-446655440002";
const DELIVERY_ID = "550e8400-e29b-41d4-a716-446655440003";
const KEY_ID = "phase5-key-v1";
const HANDOFF_AT = "2026-09-11T10:00:00.000Z";
const OBSERVED_AT = "2026-09-11T10:00:30.000Z";
const SENT_AT = "2026-09-11T10:00:31.000Z";
const CLAIMED_AT = "2026-09-11T10:00:32.000Z";
const REPLAY_EXPIRES_AT = "2026-09-11T10:05:31.000Z";
const NOW = "2026-09-11T10:02:00.000Z";
const REPLAY_KEY = `${KEY_ID}:${DELIVERY_ID}`;

const HANDOFF = {
  schema_version: 1,
  contract: "PHASE5_RPI5_SIGNER_HANDOFF_V1",
  source_repository: "rozkalnsandris/rozkalns-control-center",
  control_source_sha: CONTROL_SHA,
  worker: "rozkalns-control",
  expected_worker: {
    deployment_id: WORKER_DEPLOYMENT_ID,
    version_id: WORKER_VERSION_ID,
    traffic_percent: 100,
    ingest_state: "PRESENT_TRUE",
  },
  key_id: KEY_ID,
  observation_contract_version: "control-phase5-rpi5-observation-v1",
  generated_at: HANDOFF_AT,
  receiver: {
    repository: "rozkalnsandris/RPi5_main",
    lane: "RPI5_SIGNER_RUNTIME",
    authority_owner: "RPi5_main",
  },
  authority: {
    evidence_only: true,
    grants_live_authority: false,
    grants_cross_repo_write: false,
    grants_rpi5_runtime_mutation: false,
  },
} as const;

const WORKER_IDENTITY = {
  controlSourceSha: CONTROL_SHA,
  deploymentId: WORKER_DEPLOYMENT_ID,
  versionId: WORKER_VERSION_ID,
  trafficPercent: 100,
  ingestState: "PRESENT_TRUE",
  keyId: KEY_ID,
} as const;

const DELIVERY = {
  version: "control-phase5-rpi5-observation-v1",
  deliveryId: DELIVERY_ID,
  sentAt: SENT_AT,
  keyId: KEY_ID,
} as const;

const VISIBILITY_INPUT = {
  projectId: "hermes-tech",
  repository: "rozkalnsandris/hermes-tech",
  mainSha: PROJECT_MAIN_SHA,
  productionSha: PRODUCTION_SHA,
  deployImpact: "AUTO_DEPLOY_SAFE",
  runtime: "HEALTHY",
  health: "PASS",
  rollback: "AVAILABLE",
  blockerCodes: ["PRODUCTION_SHA_DRIFT"],
  observedAt: OBSERVED_AT,
} as const;

const VISIBILITY = {
  ...VISIBILITY_INPUT,
  productionAdapter: "rpi5",
  drift: "DRIFTED",
} as const;

function expectation(overrides: Partial<{
  handoff: unknown;
  workerIdentity: unknown;
  delivery: unknown;
  visibility: unknown;
}> = {}) {
  return {
    handoff: HANDOFF,
    workerIdentity: WORKER_IDENTITY,
    delivery: DELIVERY,
    visibility: VISIBILITY_INPUT,
    ...overrides,
  };
}

function found(
  overrides: Partial<Extract<Rpi5ObservationReconciliationReadResult, { kind: "FOUND" }>> = {},
): Extract<Rpi5ObservationReconciliationReadResult, { kind: "FOUND" }> {
  return {
    kind: "FOUND",
    replay: {
      replayKey: REPLAY_KEY,
      replayExpiresAt: REPLAY_EXPIRES_AT,
      claimedAt: CLAIMED_AT,
      atomicAcceptance: true,
    },
    projection: {
      visibility: VISIBILITY,
      storedAt: CLAIMED_AT,
    },
    ...overrides,
  };
}

function fakeReader(step: unknown | Error): {
  readonly reader: Rpi5ObservationReconciliationReader;
  readonly calls: { replayKey: string; projectId: string; repository: string }[];
} {
  const calls: { replayKey: string; projectId: string; repository: string }[] = [];
  return {
    calls,
    reader: {
      async read(replayKey: string, projectId: string, repository: string): Promise<unknown> {
        calls.push({ replayKey, projectId, repository });
        if (step instanceof Error) throw step;
        return step;
      },
    },
  };
}

test("exact fresh atomic replay plus same-acceptance projection reconciles ACCEPTED", async () => {
  const fake = fakeReader(found());
  const result = await reconcileRpi5Observation(fake.reader, expectation(), NOW);

  assert.equal(result.status, "ACCEPTED");
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.expected?.controlSourceSha, CONTROL_SHA);
  assert.equal(result.expected?.workerDeploymentId, WORKER_DEPLOYMENT_ID);
  assert.equal(result.expected?.workerVersionId, WORKER_VERSION_ID);
  assert.equal(result.expected?.replayKey, REPLAY_KEY);
  assert.equal(result.expected?.replayExpiresAt, REPLAY_EXPIRES_AT);
  assert.equal(result.observed?.replay.atomicAcceptance, true);
  assert.equal(result.observed?.projection?.storedAt, CLAIMED_AT);
  assert.deepEqual(fake.calls, [
    {
      replayKey: REPLAY_KEY,
      projectId: VISIBILITY.projectId,
      repository: VISIBILITY.repository,
    },
  ]);
  assert.deepEqual(result.authority, {
    evidenceOnly: true,
    grantsLiveAuthority: false,
    grantsRpi5Mutation: false,
    grantsCloudflareMutation: false,
    grantsD1Mutation: false,
  });

  const serialized = JSON.stringify(result);
  for (const forbidden of ["signature", "claimToken", "privateKey", "publicKeyBase64url", "rawPayload"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("no exact replay row is NOT_OBSERVED", async () => {
  const fake = fakeReader({ kind: "NOT_FOUND" });
  const result = await reconcileRpi5Observation(fake.reader, expectation(), NOW);

  assert.equal(result.status, "NOT_OBSERVED");
  assert.deepEqual(result.reasonCodes, ["NO_OBSERVATION"]);
  assert.equal(result.observed, null);
});

test("stale handoff/delivery/visibility stop before D1 read", async () => {
  const fake = fakeReader(found());
  const result = await reconcileRpi5Observation(
    fake.reader,
    expectation(),
    "2026-09-11T10:06:00.001Z",
  );

  assert.equal(result.status, "STALE");
  assert.deepEqual(result.reasonCodes, ["STALE_HANDOFF", "STALE_DELIVERY", "STALE_VISIBILITY"]);
  assert.equal(fake.calls.length, 0);
});

test("future or chronologically contradictory expected evidence is REJECTED before read", async () => {
  const future = fakeReader(found());
  const futureResult = await reconcileRpi5Observation(
    future.reader,
    expectation({
      delivery: { ...DELIVERY, sentAt: "2026-09-11T10:03:00.000Z" },
    }),
    NOW,
  );
  assert.equal(futureResult.status, "REJECTED");
  assert.deepEqual(futureResult.reasonCodes, ["FUTURE_DELIVERY"]);
  assert.equal(future.calls.length, 0);

  const chronology = fakeReader(found());
  const chronologyResult = await reconcileRpi5Observation(
    chronology.reader,
    expectation({
      delivery: { ...DELIVERY, sentAt: "2026-09-11T09:59:59.000Z" },
    }),
    NOW,
  );
  assert.equal(chronologyResult.status, "REJECTED");
  assert.deepEqual(chronologyResult.reasonCodes, [
    "DELIVERY_PRECEDES_HANDOFF",
    "OBSERVATION_AFTER_DELIVERY",
  ]);
  assert.equal(chronology.calls.length, 0);
});

test("handoff must match exact current Control/Worker/key identity", async () => {
  const fake = fakeReader(found());
  const result = await reconcileRpi5Observation(
    fake.reader,
    expectation({
      workerIdentity: {
        ...WORKER_IDENTITY,
        versionId: "550e8400-e29b-41d4-a716-446655440099",
      },
    }),
    NOW,
  );

  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.reasonCodes, ["INVALID_EXPECTATION"]);
  assert.equal(result.expected, null);
  assert.equal(fake.calls.length, 0);
});

test("replay-only or contradictory replay evidence is REJECTED", async () => {
  for (const [candidate, reason] of [
    [found({ replay: { ...found().replay, atomicAcceptance: false } }), "NON_ATOMIC_REPLAY_CLAIM"],
    [
      found({
        replay: {
          ...found().replay,
          replayExpiresAt: "2026-09-11T10:05:30.000Z",
        },
      }),
      "REPLAY_EXPIRY_MISMATCH",
    ],
    [
      found({
        replay: {
          ...found().replay,
          claimedAt: "2026-09-11T10:00:30.000Z",
        },
      }),
      "REPLAY_CLAIM_TIME_INVALID",
    ],
    [found({ projection: null }), "PROJECTION_MISSING"],
  ] as const) {
    const fake = fakeReader(candidate);
    const result = await reconcileRpi5Observation(fake.reader, expectation(), NOW);
    assert.equal(result.status, "REJECTED");
    assert.deepEqual(result.reasonCodes, [reason]);
  }
});

test("valid atomic claim with a different current projection is DRIFTED", async () => {
  const superseded = fakeReader(
    found({
      projection: {
        visibility: VISIBILITY,
        storedAt: "2026-09-11T10:00:33.000Z",
      },
    }),
  );
  const supersededResult = await reconcileRpi5Observation(superseded.reader, expectation(), NOW);
  assert.equal(supersededResult.status, "DRIFTED");
  assert.deepEqual(supersededResult.reasonCodes, ["PROJECTION_SUPERSEDED"]);

  const mismatched = fakeReader(
    found({
      projection: {
        visibility: { ...VISIBILITY, mainSha: "d".repeat(40) },
        storedAt: CLAIMED_AT,
      },
    }),
  );
  const mismatchedResult = await reconcileRpi5Observation(mismatched.reader, expectation(), NOW);
  assert.equal(mismatchedResult.status, "DRIFTED");
  assert.deepEqual(mismatchedResult.reasonCodes, ["MAIN_SHA_MISMATCH"]);
});

interface QueryCall {
  readonly query: string;
  readonly values: readonly unknown[];
}

function d1Result(
  rows: readonly Record<string, unknown>[],
  changes = 0,
): Rpi5ObservationReconciliationD1RunResultLike {
  return { success: true, results: rows, meta: { changes } };
}

function d1Row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    replay_key: REPLAY_KEY,
    replay_expires_at_ms: Date.parse(REPLAY_EXPIRES_AT),
    claimed_at_ms: Date.parse(CLAIMED_AT),
    atomic_acceptance: 1,
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
    stored_at: CLAIMED_AT,
    stored_at_ms: Date.parse(CLAIMED_AT),
    ...overrides,
  };
}

function fakeD1(step: Rpi5ObservationReconciliationD1RunResultLike | Error): {
  readonly database: Rpi5ObservationReconciliationD1DatabaseLike;
  readonly calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const database: Rpi5ObservationReconciliationD1DatabaseLike = {
    prepare(query: string): Rpi5ObservationReconciliationD1PreparedStatementLike {
      let values: readonly unknown[] = [];
      const statement: Rpi5ObservationReconciliationD1PreparedStatementLike = {
        bind(
          ...boundValues: readonly unknown[]
        ): Rpi5ObservationReconciliationD1PreparedStatementLike {
          values = boundValues;
          return statement;
        },
        async run<Row = Record<string, unknown>>(): Promise<
          Rpi5ObservationReconciliationD1RunResultLike<Row>
        > {
          calls.push({ query, values });
          if (step instanceof Error) throw step;
          return step as Rpi5ObservationReconciliationD1RunResultLike<Row>;
        },
      };
      return statement;
    },
  };
  return { database, calls };
}

test("D1 reader derives only a bounded atomic marker and one projection snapshot", async () => {
  const fake = fakeD1(d1Result([d1Row()]));
  const reader = new D1Rpi5ObservationReconciliationReader(fake.database);

  assert.deepEqual(
    await reader.read(REPLAY_KEY, VISIBILITY.projectId, VISIBILITY.repository),
    found(),
  );
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0]?.values, [
    REPLAY_KEY,
    VISIBILITY.projectId,
    VISIBILITY.repository,
  ]);
  assert.match(fake.calls[0]?.query ?? "", /CASE\s+WHEN length\(replay\.claim_token\) = 32/);
  assert.match(fake.calls[0]?.query ?? "", /END AS atomic_acceptance/);
  assert.match(fake.calls[0]?.query ?? "", /LEFT JOIN rpi5_production_visibility/);
  assert.match(fake.calls[0]?.query ?? "", /LIMIT 2$/);
});

test("D1 reader distinguishes no replay from replay without projection and rejects malformed reads", async () => {
  const none = fakeD1(d1Result([]));
  assert.deepEqual(
    await new D1Rpi5ObservationReconciliationReader(none.database).read(
      REPLAY_KEY,
      VISIBILITY.projectId,
      VISIBILITY.repository,
    ),
    { kind: "NOT_FOUND" },
  );

  const replayOnly = fakeD1(
    d1Result([
      d1Row({
        atomic_acceptance: 0,
        project_id: null,
        repository: null,
        main_sha: null,
        production_sha: null,
        deploy_impact: null,
        runtime: null,
        health: null,
        rollback: null,
        blocker_codes_json: null,
        observed_at: null,
        observed_at_ms: null,
        production_adapter: null,
        drift: null,
        stored_at: null,
        stored_at_ms: null,
      }),
    ]),
  );
  assert.deepEqual(
    await new D1Rpi5ObservationReconciliationReader(replayOnly.database).read(
      REPLAY_KEY,
      VISIBILITY.projectId,
      VISIBILITY.repository,
    ),
    found({ replay: { ...found().replay, atomicAcceptance: false }, projection: null }),
  );

  for (const step of [
    d1Result([d1Row(), d1Row()]),
    d1Result([d1Row()], 1),
    { success: false, results: [d1Row()], meta: { changes: 0 } },
    new Error("D1 unavailable"),
  ] as const) {
    const fake = fakeD1(step);
    await assert.rejects(
      new D1Rpi5ObservationReconciliationReader(fake.database).read(
        REPLAY_KEY,
        VISIBILITY.projectId,
        VISIBILITY.repository,
      ),
      /failed closed|invalid/,
    );
  }
});

test("reader failures and malformed adapter output fail closed without throwing from reconciliation", async () => {
  const failed = await reconcileRpi5Observation(
    fakeReader(new Error("unavailable")).reader,
    expectation(),
    NOW,
  );
  assert.equal(failed.status, "REJECTED");
  assert.deepEqual(failed.reasonCodes, ["READ_FAILED"]);

  const malformed = await reconcileRpi5Observation(
    fakeReader({ kind: "FOUND", replay: { replayKey: REPLAY_KEY }, projection: null }).reader,
    expectation(),
    NOW,
  );
  assert.equal(malformed.status, "REJECTED");
  assert.deepEqual(malformed.reasonCodes, ["INVALID_OBSERVATION"]);
});
