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

function result(changes: number, rows: readonly Record<string, unknown>[] = []): D1RunResultLike {
  return { success: true, meta: { changes }, results: rows };
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

test("D1 duplicate is accepted only after existing identity is proven", async () => {
  const database = new FakeD1Database([
    result(0),
    result(0, [
      {
        delivery_id: "delivery-123",
        repository: "rozkalnsandris/hermes-deals",
        project_id: "hermes-deals",
        event_name: "pull_request",
      },
    ]),
  ]);
  const store = new D1DeliveryClaimStore(database);

  assert.equal(await store.claim({ ...claim, claimedAt: "2026-08-13T20:20:00.000Z" }), "duplicate");
  assert.equal(database.prepared.length, 2);
  assert.match(database.prepared[1].sql, /WHERE delivery_id = \?1/);
  assert.deepEqual(database.prepared[1].values, ["delivery-123"]);
});

test("D1 duplicate identity mismatch fails closed", async () => {
  const database = new FakeD1Database([
    result(0),
    result(0, [
      {
        delivery_id: "delivery-123",
        repository: "rozkalnsandris/hermes-tech",
        project_id: "hermes-tech",
        event_name: "push",
      },
    ]),
  ]);
  const store = new D1DeliveryClaimStore(database);

  await assert.rejects(() => store.claim(claim), D1DeliveryClaimError);
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
