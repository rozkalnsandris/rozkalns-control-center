import assert from "node:assert/strict";
import test from "node:test";

import {
  D1DeliveryObservabilityError,
  D1WebhookDeliveryObservabilityReader,
  WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT,
  WEBHOOK_DELIVERY_STALE_AFTER_SECONDS,
  type WebhookDeliveryObservabilityReader,
  type WebhookDeliveryObservabilitySnapshot,
} from "../src/integrations/cloudflare/d1-delivery-observability-reader.js";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import {
  GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH,
  handleGitHubWebhookObservabilityRequest,
} from "../src/worker/github-webhook-observability-route.js";

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
    return this.#statement(call);
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

function result(rows: readonly Record<string, unknown>[], success = true): D1RunResultLike {
  return { success, meta: { changes: 0 }, results: rows };
}

function countRow(state: string, count: number) {
  return { state, count };
}

function diagnosticRow(overrides: Record<string, unknown> = {}) {
  return {
    delivery_id: "delivery-146",
    repository: "rozkalnsandris/hermes-deals",
    project_id: "hermes-deals",
    event_name: "pull_request",
    state: "ENQUEUED",
    attempt_count: 0,
    received_at: "2026-08-15T11:40:00.000Z",
    updated_at: "2026-08-15T11:41:00.000Z",
    last_error_code: null,
    ...overrides,
  };
}

const OBSERVED_AT = "2026-08-15T11:50:00.000Z";

function snapshot(overrides: Partial<WebhookDeliveryObservabilitySnapshot> = {}): WebhookDeliveryObservabilitySnapshot {
  return {
    observedAt: OBSERVED_AT,
    status: "HEALTHY",
    staleAfterSeconds: WEBHOOK_DELIVERY_STALE_AFTER_SECONDS,
    totalDeliveries: 0,
    nonTerminalCount: 0,
    deadLetteredCount: 0,
    staleEvidenceCount: 0,
    counts: {
      RECEIVED: 0,
      ENQUEUED: 0,
      PROCESSING: 0,
      RETRY_PENDING: 0,
      SUCCEEDED: 0,
      DEAD_LETTERED: 0,
    },
    diagnostics: [],
    diagnosticsTruncated: false,
    ...overrides,
  };
}

test("delivery observability reports healthy when only completed work exists", async () => {
  const database = new FakeD1Database([
    result([countRow("SUCCEEDED", 12)]),
    result([]),
  ]);

  const observed = await new D1WebhookDeliveryObservabilityReader(database).readSnapshot(OBSERVED_AT);

  assert.equal(observed.status, "HEALTHY");
  assert.equal(observed.totalDeliveries, 12);
  assert.equal(observed.nonTerminalCount, 0);
  assert.equal(observed.deadLetteredCount, 0);
  assert.deepEqual(observed.diagnostics, []);
  assert.match(database.prepared[0].sql, /GROUP BY state/);
  assert.match(database.prepared[1].sql, /state <> 'SUCCEEDED'/);
  assert.deepEqual(database.prepared[1].values, [WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT + 1]);
});

test("recent non-terminal delivery is active without false attention", async () => {
  const database = new FakeD1Database([
    result([countRow("ENQUEUED", 1), countRow("SUCCEEDED", 2)]),
    result([diagnosticRow()]),
  ]);

  const observed = await new D1WebhookDeliveryObservabilityReader(database).readSnapshot(OBSERVED_AT);

  assert.equal(observed.status, "ACTIVE");
  assert.equal(observed.nonTerminalCount, 1);
  assert.equal(observed.staleEvidenceCount, 0);
  assert.equal(observed.diagnostics[0]?.disposition, "ACTIVE");
});

test("stale non-terminal delivery produces bounded attention evidence", async () => {
  const database = new FakeD1Database([
    result([countRow("RECEIVED", 1)]),
    result([
      diagnosticRow({
        state: "RECEIVED",
        received_at: "2026-08-15T11:20:00.000Z",
        updated_at: "2026-08-15T11:20:00.000Z",
      }),
    ]),
  ]);

  const observed = await new D1WebhookDeliveryObservabilityReader(database).readSnapshot(OBSERVED_AT);

  assert.equal(observed.status, "ATTENTION");
  assert.equal(observed.staleEvidenceCount, 1);
  assert.equal(observed.diagnostics[0]?.disposition, "STALE");
});

test("dead-lettered delivery is always attention and exposes only stable error evidence", async () => {
  const database = new FakeD1Database([
    result([countRow("DEAD_LETTERED", 1)]),
    result([
      diagnosticRow({
        state: "DEAD_LETTERED",
        attempt_count: 4,
        last_error_code: "QUEUE_RETRY_EXHAUSTED",
      }),
    ]),
  ]);

  const observed = await new D1WebhookDeliveryObservabilityReader(database).readSnapshot(OBSERVED_AT);

  assert.equal(observed.status, "ATTENTION");
  assert.equal(observed.deadLetteredCount, 1);
  assert.equal(observed.diagnostics[0]?.disposition, "DEAD_LETTERED");
  assert.equal(observed.diagnostics[0]?.lastErrorCode, "QUEUE_RETRY_EXHAUSTED");
  assert.doesNotMatch(JSON.stringify(observed), /token=|private[_-]?key|webhook.*secret/i);
});

test("diagnostic evidence is capped and truncation is explicit", async () => {
  const rows = Array.from({ length: WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT + 1 }, (_, index) =>
    diagnosticRow({
      delivery_id: `delivery-${index + 1}`,
      updated_at: "2026-08-15T11:49:00.000Z",
    }),
  );
  const database = new FakeD1Database([
    result([countRow("ENQUEUED", rows.length)]),
    result(rows),
  ]);

  const observed = await new D1WebhookDeliveryObservabilityReader(database).readSnapshot(OBSERVED_AT);

  assert.equal(observed.diagnostics.length, WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT);
  assert.equal(observed.diagnosticsTruncated, true);
  assert.equal(observed.status, "ACTIVE");
});

test("malformed or temporally inconsistent D1 observability evidence fails closed", async () => {
  const duplicateAggregate = new FakeD1Database([
    result([countRow("RECEIVED", 1), countRow("RECEIVED", 1)]),
  ]);
  await assert.rejects(
    () => new D1WebhookDeliveryObservabilityReader(duplicateAggregate).readSnapshot(OBSERVED_AT),
    D1DeliveryObservabilityError,
  );

  const futureUpdate = new FakeD1Database([
    result([countRow("ENQUEUED", 1)]),
    result([diagnosticRow({ updated_at: "2026-08-15T11:51:00.000Z" })]),
  ]);
  await assert.rejects(
    () => new D1WebhookDeliveryObservabilityReader(futureUpdate).readSnapshot(OBSERVED_AT),
    D1DeliveryObservabilityError,
  );
});

test("observability route is GET-only, query-free, no-store and fail-closed when disabled", async () => {
  const disabled = await handleGitHubWebhookObservabilityRequest(
    new Request(`https://control.example${GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH}`),
    OBSERVED_AT,
    null,
  );
  assert.equal(disabled.status, 503);
  assert.equal(disabled.headers.get("cache-control"), "no-store");
  assert.deepEqual(await disabled.json(), { error: "WEBHOOK_OBSERVABILITY_DISABLED" });

  const method = await handleGitHubWebhookObservabilityRequest(
    new Request(`https://control.example${GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH}`, { method: "POST" }),
    OBSERVED_AT,
    null,
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");

  const query = await handleGitHubWebhookObservabilityRequest(
    new Request(`https://control.example${GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH}?all=true`),
    OBSERVED_AT,
    null,
  );
  assert.equal(query.status, 400);
});

test("observability route returns the bounded snapshot and sanitizes reader failure", async () => {
  const expected = snapshot({ totalDeliveries: 7 });
  const reader: WebhookDeliveryObservabilityReader = {
    readSnapshot: async (observedAt) => {
      assert.equal(observedAt, OBSERVED_AT);
      return expected;
    },
  };

  const response = await handleGitHubWebhookObservabilityRequest(
    new Request(`https://control.example${GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH}`),
    OBSERVED_AT,
    reader,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), expected);

  const failingReader: WebhookDeliveryObservabilityReader = {
    readSnapshot: async () => {
      throw new Error("token=must-never-leak");
    },
  };
  const failed = await handleGitHubWebhookObservabilityRequest(
    new Request(`https://control.example${GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH}`),
    OBSERVED_AT,
    failingReader,
  );
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "WEBHOOK_OBSERVABILITY_FAILED" });
});
