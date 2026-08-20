import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

function result(changes: number, rows: readonly Record<string, unknown>[] = []): D1RunResultLike {
  return { success: true, meta: { changes }, results: rows };
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

function dispatchAttempt(
  attemptNumber = 1,
  attemptedAt = "2026-08-20T08:05:00.000Z",
): NotificationDeliveryDispatchAttempt {
  return notificationDeliveryDispatchAttempt(
    envelope,
    {
      kind: "READY",
      attemptNumber,
      eligibleAt: attemptedAt,
    },
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

test("first claim is one atomic bounded insert and authorizes only the first executor", async () => {
  const attempt = dispatchAttempt();
  const database = new FakeD1Database([result(1)]);
  const store = new D1NotificationDeliveryDispatchClaimStore(database);

  assert.deepEqual(await store.claim(attempt), { kind: "CLAIMED" });
  assert.equal(database.prepared.length, 1);
  assert.match(database.prepared[0].sql, /INSERT INTO notification_delivery_dispatch_claims/);
  assert.match(database.prepared[0].sql, /ON CONFLICT DO NOTHING/);
  assert.doesNotMatch(database.prepared[0].sql, /telegram|web_push|access_token|secret|credential/i);
  assert.deepEqual(database.prepared[0].values, [
    attempt.dispatchId,
    1,
    attempt.deliveryId,
    1,
    attempt.envelope.transitionId,
    attempt.envelope.targetKey,
    attempt.attemptedAt,
  ]);
});

test("exact durable replay returns ALREADY_CLAIMED so a caller must not send again", async () => {
  const attempt = dispatchAttempt();
  const database = new FakeD1Database([
    result(0),
    result(0, [storedRow(attempt)]),
  ]);

  assert.deepEqual(await new D1NotificationDeliveryDispatchClaimStore(database).claim(attempt), {
    kind: "ALREADY_CLAIMED",
  });
  assert.equal(database.prepared.length, 2);
  assert.match(database.prepared[1].sql, /WHERE dispatch_id = \?1/);
  assert.deepEqual(database.prepared[1].values, [attempt.dispatchId]);
});

test("collision or durable evidence drift fails closed instead of reopening provider execution", async () => {
  const attempt = dispatchAttempt();
  const timestampDrift = new FakeD1Database([
    result(0),
    result(0, [storedRow(attempt, { attempted_at: "2026-08-20T08:06:00.000Z" })]),
  ]);
  await assert.rejects(
    () => new D1NotificationDeliveryDispatchClaimStore(timestampDrift).claim(attempt),
    D1NotificationDeliveryDispatchClaimStoreError,
  );

  const identityDrift = new FakeD1Database([
    result(0),
    result(0, [storedRow(attempt, { dispatch_id: "dispatch-v1-ffffffffffffffff-1" })]),
  ]);
  await assert.rejects(
    () => new D1NotificationDeliveryDispatchClaimStore(identityDrift).claim(attempt),
    D1NotificationDeliveryDispatchClaimStoreError,
  );

  const unresolvedPairCollision = new FakeD1Database([result(0), result(0)]);
  await assert.rejects(
    () => new D1NotificationDeliveryDispatchClaimStore(unresolvedPairCollision).claim(attempt),
    D1NotificationDeliveryDispatchClaimStoreError,
  );
});

test("malformed or drifted dispatch evidence is rejected before D1", async () => {
  const attempt = dispatchAttempt();
  const dispatchDrift = {
    ...attempt,
    dispatchId: "dispatch-v1-ffffffffffffffff-1",
  } as NotificationDeliveryDispatchAttempt;
  const database = new FakeD1Database([]);

  await assert.rejects(
    () => new D1NotificationDeliveryDispatchClaimStore(database).claim(dispatchDrift),
    D1NotificationDeliveryDispatchClaimStoreError,
  );
  assert.equal(database.prepared.length, 0);

  const timestampDrift = {
    ...attempt,
    attemptedAt: "2026-08-20T10:05:00+02:00",
  } as NotificationDeliveryDispatchAttempt;
  await assert.rejects(
    () => new D1NotificationDeliveryDispatchClaimStore(database).claim(timestampDrift),
    D1NotificationDeliveryDispatchClaimStoreError,
  );
  assert.equal(database.prepared.length, 0);
});

test("0006 schema stores only bounded dispatch identity and enforces one claim per delivery attempt", () => {
  const migration0004 = readFileSync(
    resolve(process.cwd(), "migrations/0004_notification_delivery_intents.sql"),
    "utf8",
  );
  const migration0006 = readFileSync(
    resolve(process.cwd(), "migrations/0006_notification_delivery_dispatch_claims.sql"),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  const attempt = dispatchAttempt();

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migration0004);
    database.exec(migration0006);

    const columns = database
      .prepare("PRAGMA table_info(notification_delivery_dispatch_claims)")
      .all() as Array<{ name: string; pk: number }>;
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "dispatch_id",
        "schema_version",
        "delivery_id",
        "attempt_number",
        "transition_id",
        "target_key",
        "attempted_at",
      ],
    );
    assert.equal(columns.find((column) => column.name === "dispatch_id")?.pk, 1);
    assert.doesNotMatch(
      columns.map((column) => column.name).join(" "),
      /telegram|web_push|token|secret|credential|payload/i,
    );

    database.prepare(`
      INSERT INTO notification_delivery_intents (
        delivery_id, schema_version, transition_id, target_key, signal,
        decision_id, project_id, reference, title, body, deep_link_path, queued_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.deliveryId,
      envelope.transitionId,
      envelope.targetKey,
      envelope.signal,
      envelope.decisionId,
      envelope.projectId,
      envelope.reference,
      envelope.title,
      envelope.body,
      envelope.deepLinkPath,
      "2026-08-20T08:00:00.000Z",
    );

    const insert = database.prepare(`
      INSERT INTO notification_delivery_dispatch_claims (
        dispatch_id, schema_version, delivery_id, attempt_number,
        transition_id, target_key, attempted_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?)
    `);
    insert.run(
      attempt.dispatchId,
      attempt.deliveryId,
      attempt.attemptNumber,
      attempt.envelope.transitionId,
      attempt.envelope.targetKey,
      attempt.attemptedAt,
    );

    assert.throws(() =>
      insert.run(
        "dispatch-v1-fedcba9876543210-1",
        attempt.deliveryId,
        1,
        attempt.envelope.transitionId,
        attempt.envelope.targetKey,
        attempt.attemptedAt,
      ),
    );
    assert.throws(() =>
      insert.run(
        "dispatch-v1-0123456789abcdef-9",
        attempt.deliveryId,
        9,
        attempt.envelope.transitionId,
        attempt.envelope.targetKey,
        attempt.attemptedAt,
      ),
    );
    assert.throws(() =>
      insert.run(
        "dispatch-v1-fedcba9876543210-2",
        attempt.deliveryId,
        2,
        attempt.envelope.transitionId,
        "Primary target",
        attempt.attemptedAt,
      ),
    );
    assert.throws(() =>
      insert.run(
        "dispatch-v1-fedcba9876543210-2",
        "delivery-v1-fedcba9876543210",
        2,
        attempt.envelope.transitionId,
        attempt.envelope.targetKey,
        attempt.attemptedAt,
      ),
    );
  } finally {
    database.close();
  }
});

test("dispatch claim persistence remains detached from Worker, Queue and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /notification-delivery-dispatch-claim-store|D1NotificationDeliveryDispatchClaimStore|notification_delivery_dispatch_claims/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
