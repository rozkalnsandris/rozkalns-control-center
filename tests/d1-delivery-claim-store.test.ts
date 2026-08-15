import assert from "node:assert/strict";
import test from "node:test";

import {
  D1DeliveryClaimError,
  D1DeliveryClaimStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";

interface PreparedCall {
  readonly sql: string;
  values: readonly unknown[];
}

class FakeD1Database implements D1DatabaseLike {
  readonly prepared: PreparedCall[] = [];
  readonly #results: D1RunResultLike[];

  constructor(results: readonly D1RunResultLike[]) {
    this.#results = [...results];
  }

  prepare(sql: string): D1PreparedStatementLike {
    const call: PreparedCall = { sql, values: [] };
    this.prepared.push(call);

    return {
      bind: (...values: readonly unknown[]) => {
        call.values = values;
        return this.#statement(call);
      },
      run: async <Row = Record<string, unknown>>() => this.#nextResult() as D1RunResultLike<Row>,
    };
  }

  #statement(call: PreparedCall): D1PreparedStatementLike {
    return {
      bind: (...values: readonly unknown[]) => {
        call.values = values;
        return this.#statement(call);
      },
      run: async <Row = Record<string, unknown>>() => this.#nextResult() as D1RunResultLike<Row>,
    };
  }

  #nextResult(): D1RunResultLike {
    const result = this.#results.shift();
    if (!result) throw new Error("Unexpected fake D1 execution");
    return result;
  }
}

const claim = {
  deliveryId: "delivery-123",
  repository: "rozkalnsandris/hermes-deals",
  eventName: "pull_request",
  claimedAt: "2026-08-13T20:15:00.000Z",
};

const identity = {
  deliveryId: "delivery-123",
  repository: "rozkalnsandris/hermes-deals",
  projectId: "hermes-deals",
  eventName: "pull_request",
};

function result(changes: number, rows: readonly Record<string, unknown>[] = []): D1RunResultLike {
  return { success: true, meta: { changes }, results: rows };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    delivery_id: "delivery-123",
    repository: "rozkalnsandris/hermes-deals",
    project_id: "hermes-deals",
    event_name: "pull_request",
    message_version: 1,
    state: "RECEIVED",
    attempt_count: 0,
    received_at: "2026-08-13T20:15:00.000Z",
    enqueued_at: null,
    processing_started_at: null,
    last_attempt_at: null,
    updated_at: "2026-08-13T20:15:00.000Z",
    completed_at: null,
    dead_lettered_at: null,
    last_error_code: null,
    ...overrides,
  };
}

test("D1 claim uses one prepared bound insert and records only durable identity metadata", async () => {
  const database = new FakeD1Database([result(1)]);
  const store = new D1DeliveryClaimStore(database);

  assert.equal(await store.claim(claim), "claimed");
  assert.equal(database.prepared.length, 1);

  const insert = database.prepared[0];
  assert.match(insert.sql, /INSERT INTO webhook_deliveries/);
  assert.match(insert.sql, /ON CONFLICT\(delivery_id\) DO NOTHING/);
  assert.match(insert.sql, /'RECEIVED'/);
  assert.doesNotMatch(insert.sql, /payload|token|secret|private_key/i);
  assert.deepEqual(insert.values, [
    "delivery-123",
    "rozkalnsandris/hermes-deals",
    "hermes-deals",
    "pull_request",
    "2026-08-13T20:15:00.000Z",
  ]);
});

test("D1 duplicate is accepted only after existing identity and recoverable state are proven", async () => {
  const database = new FakeD1Database([result(0), result(0, [storedRow()])]);
  const store = new D1DeliveryClaimStore(database);

  assert.equal(await store.claim({ ...claim, claimedAt: "2026-08-13T20:20:00.000Z" }), "duplicate");
  assert.equal(database.prepared.length, 2);
  assert.match(database.prepared[1].sql, /state/);
  assert.match(database.prepared[1].sql, /WHERE delivery_id = \?1/);
  assert.deepEqual(database.prepared[1].values, ["delivery-123"]);
});

test("D1 read returns the complete exact durable lifecycle identity", async () => {
  const database = new FakeD1Database([
    result(0, [storedRow({
      state: "RETRY_PENDING",
      attempt_count: 2,
      enqueued_at: "2026-08-13T20:15:01.000Z",
      processing_started_at: "2026-08-13T20:15:02.000Z",
      last_attempt_at: "2026-08-13T20:15:02.000Z",
      updated_at: "2026-08-13T20:15:03.000Z",
      last_error_code: "AUTHORITATIVE_RECONCILIATION_FAILED",
    })]),
  ]);
  const store = new D1DeliveryClaimStore(database);

  assert.deepEqual(await store.readDelivery("delivery-123"), {
    deliveryId: "delivery-123",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    eventName: "pull_request",
    messageVersion: 1,
    state: "RETRY_PENDING",
    attemptCount: 2,
    receivedAt: "2026-08-13T20:15:00.000Z",
    enqueuedAt: "2026-08-13T20:15:01.000Z",
    processingStartedAt: "2026-08-13T20:15:02.000Z",
    lastAttemptAt: "2026-08-13T20:15:02.000Z",
    updatedAt: "2026-08-13T20:15:03.000Z",
    completedAt: null,
    deadLetteredAt: null,
    lastErrorCode: "AUTHORITATIVE_RECONCILIATION_FAILED",
  });
});

test("D1 duplicate identity mismatch fails closed", async () => {
  const database = new FakeD1Database([
    result(0),
    result(0, [storedRow({ repository: "rozkalnsandris/hermes-tech", project_id: "hermes-tech" })]),
  ]);
  const store = new D1DeliveryClaimStore(database);

  await assert.rejects(() => store.claim(claim), D1DeliveryClaimError);
});

test("D1 durable read rejects unsupported state, version, malformed lifecycle fields and ambiguous rows", async () => {
  const badState = new FakeD1Database([result(0, [storedRow({ state: "UNKNOWN" })])]);
  await assert.rejects(() => new D1DeliveryClaimStore(badState).readDelivery("delivery-123"), D1DeliveryClaimError);

  const badVersion = new FakeD1Database([result(0, [storedRow({ message_version: 2 })])]);
  await assert.rejects(() => new D1DeliveryClaimStore(badVersion).readDelivery("delivery-123"), D1DeliveryClaimError);

  const badAttempts = new FakeD1Database([result(0, [storedRow({ attempt_count: -1 })])]);
  await assert.rejects(() => new D1DeliveryClaimStore(badAttempts).readDelivery("delivery-123"), D1DeliveryClaimError);

  const badError = new FakeD1Database([result(0, [storedRow({ last_error_code: "secret detail" })])]);
  await assert.rejects(() => new D1DeliveryClaimStore(badError).readDelivery("delivery-123"), D1DeliveryClaimError);

  const missing = new FakeD1Database([result(0)]);
  await assert.rejects(() => new D1DeliveryClaimStore(missing).readDelivery("delivery-123"), D1DeliveryClaimError);
});

test("D1 markEnqueued is an exact conditional RECEIVED transition", async () => {
  const database = new FakeD1Database([result(1)]);
  const store = new D1DeliveryClaimStore(database);

  await store.markEnqueued(claim, "2026-08-13T20:15:01.000Z");
  assert.equal(database.prepared.length, 1);

  const update = database.prepared[0];
  assert.match(update.sql, /SET\s+state = 'ENQUEUED'/s);
  assert.match(update.sql, /AND state = 'RECEIVED'/);
  assert.match(update.sql, /repository = \?2/);
  assert.match(update.sql, /project_id = \?3/);
  assert.match(update.sql, /event_name = \?4/);
  assert.deepEqual(update.values, [
    "delivery-123",
    "rozkalnsandris/hermes-deals",
    "hermes-deals",
    "pull_request",
    "2026-08-13T20:15:01.000Z",
  ]);
});

test("D1 processing attempts are exact, retry-safe and increment attempt_count", async () => {
  const database = new FakeD1Database([result(1)]);
  const store = new D1DeliveryClaimStore(database);

  await store.markProcessing(identity, "2026-08-13T20:16:00.000Z");
  const update = database.prepared[0];
  assert.match(update.sql, /state = 'PROCESSING'/);
  assert.match(update.sql, /attempt_count = attempt_count \+ 1/);
  assert.match(update.sql, /state IN \('ENQUEUED', 'RETRY_PENDING', 'PROCESSING'\)/);
  assert.deepEqual(update.values, [
    "delivery-123",
    "rozkalnsandris/hermes-deals",
    "hermes-deals",
    "pull_request",
    "2026-08-13T20:16:00.000Z",
  ]);
});

test("D1 retry, success and dead-letter transitions persist only stable bounded evidence", async () => {
  const database = new FakeD1Database([result(1), result(1), result(1)]);
  const store = new D1DeliveryClaimStore(database);

  await store.markRetryPending(
    identity,
    "2026-08-13T20:16:01.000Z",
    "AUTHORITATIVE_RECONCILIATION_FAILED",
  );
  await store.markSucceeded(identity, "2026-08-13T20:16:02.000Z");
  await store.markDeadLettered(identity, "2026-08-13T20:16:03.000Z", "QUEUE_RETRY_EXHAUSTED");

  assert.match(database.prepared[0].sql, /state = 'RETRY_PENDING'/);
  assert.match(database.prepared[0].sql, /AND state = 'PROCESSING'/);
  assert.deepEqual(database.prepared[0].values.slice(-2), [
    "AUTHORITATIVE_RECONCILIATION_FAILED",
    "2026-08-13T20:16:01.000Z",
  ]);

  assert.match(database.prepared[1].sql, /state = 'SUCCEEDED'/);
  assert.match(database.prepared[1].sql, /last_error_code = NULL/);
  assert.match(database.prepared[1].sql, /AND state = 'PROCESSING'/);

  assert.match(database.prepared[2].sql, /state = 'DEAD_LETTERED'/);
  assert.match(database.prepared[2].sql, /state IN \('ENQUEUED', 'PROCESSING', 'RETRY_PENDING'\)/);
  assert.deepEqual(database.prepared[2].values.slice(-2), [
    "QUEUE_RETRY_EXHAUSTED",
    "2026-08-13T20:16:03.000Z",
  ]);
});

test("D1 lifecycle transitions fail closed on state drift and malformed error evidence", async () => {
  const raced = new FakeD1Database([result(0)]);
  await assert.rejects(
    () => new D1DeliveryClaimStore(raced).markProcessing(identity, "2026-08-13T20:17:00.000Z"),
    D1DeliveryClaimError,
  );

  const invalidCode = new FakeD1Database([]);
  await assert.rejects(
    () => new D1DeliveryClaimStore(invalidCode).markRetryPending(
      identity,
      "2026-08-13T20:17:01.000Z",
      "token=secret detail",
    ),
    /stable non-secret error code/,
  );
  assert.equal(invalidCode.prepared.length, 0);
});

test("D1 markEnqueued fails closed when the RECEIVED transition races or drifts", async () => {
  const database = new FakeD1Database([result(0)]);
  const store = new D1DeliveryClaimStore(database);

  await assert.rejects(
    () => store.markEnqueued(claim, "2026-08-13T20:15:01.000Z"),
    D1DeliveryClaimError,
  );
});

test("D1 claim validates identity and timestamp before database execution", async () => {
  const invalidClaims = [
    { ...claim, deliveryId: "bad id" },
    { ...claim, eventName: "bad event" },
    { ...claim, repository: "someone/unknown" },
    { ...claim, claimedAt: "2026-08-13 20:15:00" },
  ];

  for (const invalid of invalidClaims) {
    const database = new FakeD1Database([]);
    const store = new D1DeliveryClaimStore(database);
    await assert.rejects(() => store.claim(invalid));
    assert.equal(database.prepared.length, 0);
  }
});

test("D1 claim rejects failed or ambiguous insert outcomes", async () => {
  const failed = new FakeD1Database([{ success: false, meta: { changes: 0 }, results: [] }]);
  await assert.rejects(() => new D1DeliveryClaimStore(failed).claim(claim), D1DeliveryClaimError);

  const ambiguous = new FakeD1Database([result(2)]);
  await assert.rejects(() => new D1DeliveryClaimStore(ambiguous).claim(claim), D1DeliveryClaimError);
});
