import assert from "node:assert/strict";
import test from "node:test";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import {
  D1NotificationDeliveryDispatchClaimStore,
  D1NotificationDeliveryDispatchClaimStoreError,
} from "../src/integrations/cloudflare/d1-notification-delivery-dispatch-claim-store.js";
import {
  notificationDeliveryDispatchAttempt,
  type NotificationDeliveryDispatchAttempt,
} from "../src/shared/notification-delivery-dispatch-attempt.js";
import { notificationDeliveryEnvelope } from "../src/shared/notification-delivery.js";
import type { NotificationCandidate } from "../src/shared/notification-transition.js";

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
      run: async <Row = Record<string, unknown>>() => this.#next() as D1RunResultLike<Row>,
    };
  }

  #next(): D1RunResultLike {
    const value = this.#results.shift();
    if (!value) throw new Error("Unexpected fake D1 execution");
    return value;
  }
}

function result(
  changes: number,
  rows: readonly Record<string, unknown>[] = [],
  success = true,
): D1RunResultLike {
  return { success, meta: { changes }, results: rows };
}

const candidate: NotificationCandidate = {
  schemaVersion: 1,
  signal: "NEEDS_ANDRIS",
  transitionId: "notification-v1-needs-andris-0123456789abcdef",
  decisionId: "github:hermes-deals:pr:517",
  projectId: "hermes-deals",
  reference: "PR #517",
  title: "Owner decision required",
  body: "Review the exact decision before continuing",
  deepLinkPath: "/#decision-6769746875623a6865726d65732d6465616c733a70723a353137",
};

const envelope = notificationDeliveryEnvelope(candidate, "primary");

function dispatchAttempt(): NotificationDeliveryDispatchAttempt {
  const attemptedAt = "2026-08-20T08:05:00.000Z";
  return notificationDeliveryDispatchAttempt(
    envelope,
    { kind: "READY", attemptNumber: 1, eligibleAt: attemptedAt },
    attemptedAt,
  );
}

function storedRow(
  attempt: NotificationDeliveryDispatchAttempt,
  overrides: Partial<{
    dispatch_id: string;
    schema_version: number;
    delivery_id: string;
    attempt_number: number;
    transition_id: string;
    target_key: string;
    attempted_at: string;
  }> = {},
) {
  return {
    dispatch_id: attempt.dispatchId,
    schema_version: attempt.schemaVersion,
    delivery_id: attempt.deliveryId,
    attempt_number: attempt.attemptNumber,
    transition_id: attempt.envelope.transitionId,
    target_key: attempt.envelope.targetKey,
    attempted_at: attempt.attemptedAt,
    ...overrides,
  };
}

test("read-only claim evidence returns NOT_CLAIMED without any INSERT", async () => {
  const attempt = dispatchAttempt();
  const database = new FakeD1Database([result(0)]);
  const store = new D1NotificationDeliveryDispatchClaimStore(database);

  assert.deepEqual(await store.read(attempt), { kind: "NOT_CLAIMED" });
  assert.equal(database.prepared.length, 1);
  assert.match(database.prepared[0].sql, /^SELECT/m);
  assert.doesNotMatch(database.prepared[0].sql, /INSERT|UPDATE|DELETE/i);
  assert.deepEqual(database.prepared[0].values, [attempt.dispatchId]);
});

test("read-only claim evidence returns CLAIMED only for the exact durable row", async () => {
  const attempt = dispatchAttempt();
  const database = new FakeD1Database([result(0, [storedRow(attempt)])]);
  const store = new D1NotificationDeliveryDispatchClaimStore(database);

  assert.deepEqual(await store.read(attempt), { kind: "CLAIMED" });
  assert.equal(database.prepared.length, 1);
  assert.deepEqual(database.prepared[0].values, [attempt.dispatchId]);
});

test("stored claim drift or non-unique evidence fails closed", async () => {
  const attempt = dispatchAttempt();
  const timestampDrift = new FakeD1Database([
    result(0, [storedRow(attempt, { attempted_at: "2026-08-20T08:06:00.000Z" })]),
  ]);
  await assert.rejects(
    () => new D1NotificationDeliveryDispatchClaimStore(timestampDrift).read(attempt),
    D1NotificationDeliveryDispatchClaimStoreError,
  );

  const nonUnique = new FakeD1Database([
    result(0, [storedRow(attempt), storedRow(attempt)]),
  ]);
  await assert.rejects(
    () => new D1NotificationDeliveryDispatchClaimStore(nonUnique).read(attempt),
    D1NotificationDeliveryDispatchClaimStoreError,
  );
});

test("failed D1 read is unconfirmed claim evidence", async () => {
  const attempt = dispatchAttempt();
  const database = new FakeD1Database([result(0, [], false)]);

  await assert.rejects(
    () => new D1NotificationDeliveryDispatchClaimStore(database).read(attempt),
    D1NotificationDeliveryDispatchClaimStoreError,
  );
});

test("malformed dispatch identity is rejected before D1 read", async () => {
  const attempt = dispatchAttempt();
  const malformed = {
    ...attempt,
    dispatchId: "dispatch-v1-ffffffffffffffff-1",
  } as NotificationDeliveryDispatchAttempt;
  const database = new FakeD1Database([]);

  await assert.rejects(
    () => new D1NotificationDeliveryDispatchClaimStore(database).read(malformed),
    D1NotificationDeliveryDispatchClaimStoreError,
  );
  assert.equal(database.prepared.length, 0);
});
