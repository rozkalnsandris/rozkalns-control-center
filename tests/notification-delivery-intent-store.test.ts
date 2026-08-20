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
  D1NotificationDeliveryIntentStore,
  D1NotificationDeliveryIntentStoreError,
} from "../src/integrations/cloudflare/d1-notification-delivery-intent-store.js";
import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
} from "../src/shared/notification-delivery.js";
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
  signal: "CI_FAILED",
  transitionId: "notification-v1-ci-failed-0123456789abcdef",
  decisionId: "github:hermes-deals:pr:517",
  projectId: "hermes-deals",
  reference: "PR #517",
  title: "Fix Lidl weekly offer import",
  body: "CI failed after the latest source change",
  deepLinkPath: "/#decision-6769746875623a6865726d65732d6465616c733a70723a353137",
};

const envelope = notificationDeliveryEnvelope(candidate, "primary");
const QUEUED_AT = "2026-08-20T05:20:00.000Z";

function storedRow(
  overrides: Partial<{
    delivery_id: string;
    schema_version: number;
    transition_id: string;
    target_key: string;
    signal: string;
    decision_id: string;
    project_id: string;
    reference: string;
    title: string;
    body: string;
    deep_link_path: string;
    queued_at: string;
  }> = {},
) {
  return {
    delivery_id: envelope.deliveryId,
    schema_version: envelope.schemaVersion,
    transition_id: envelope.transitionId,
    target_key: envelope.targetKey,
    signal: envelope.signal,
    decision_id: envelope.decisionId,
    project_id: envelope.projectId,
    reference: envelope.reference,
    title: envelope.title,
    body: envelope.body,
    deep_link_path: envelope.deepLinkPath,
    queued_at: QUEUED_AT,
    ...overrides,
  };
}

test("first delivery intent enqueue is one atomic bound insert without provider secrets", async () => {
  const database = new FakeD1Database([result(1)]);
  const store = new D1NotificationDeliveryIntentStore(database);

  assert.deepEqual(await store.enqueue({ envelope, queuedAt: QUEUED_AT }), { kind: "ENQUEUED" });
  assert.equal(database.prepared.length, 1);

  const insert = database.prepared[0];
  assert.match(insert.sql, /INSERT INTO notification_delivery_intents/);
  assert.match(insert.sql, /ON CONFLICT\(delivery_id\) DO NOTHING/);
  assert.doesNotMatch(insert.sql, /telegram|web_push|access_token|secret|credential/i);
  assert.deepEqual(insert.values, [
    envelope.deliveryId,
    1,
    envelope.transitionId,
    envelope.targetKey,
    envelope.signal,
    envelope.decisionId,
    envelope.projectId,
    envelope.reference,
    envelope.title,
    envelope.body,
    envelope.deepLinkPath,
    QUEUED_AT,
  ]);
});

test("exact duplicate intent re-reads durable envelope and preserves the first queued time", async () => {
  const database = new FakeD1Database([result(0), result(0, [storedRow()])]);
  const store = new D1NotificationDeliveryIntentStore(database);

  assert.deepEqual(
    await store.enqueue({ envelope, queuedAt: "2026-08-20T06:20:00.000Z" }),
    { kind: "DUPLICATE" },
  );
  assert.equal(database.prepared.length, 2);
  assert.match(database.prepared[1].sql, /WHERE delivery_id = \?1/);
  assert.deepEqual(database.prepared[1].values, [envelope.deliveryId]);
});

test("delivery-id collision or durable envelope drift fails closed", async () => {
  const database = new FakeD1Database([
    result(0),
    result(0, [storedRow({ title: "Different durable delivery intent" })]),
  ]);

  await assert.rejects(
    () => new D1NotificationDeliveryIntentStore(database).enqueue({ envelope, queuedAt: QUEUED_AT }),
    D1NotificationDeliveryIntentStoreError,
  );
});

test("malformed or ambiguous stored delivery evidence fails closed", async () => {
  const malformedTime = new FakeD1Database([
    result(0),
    result(0, [storedRow({ queued_at: "not-a-time" })]),
  ]);
  await assert.rejects(
    () =>
      new D1NotificationDeliveryIntentStore(malformedTime).enqueue({
        envelope,
        queuedAt: QUEUED_AT,
      }),
    D1NotificationDeliveryIntentStoreError,
  );

  const malformedTarget = new FakeD1Database([
    result(0),
    result(0, [storedRow({ target_key: "Primary target" })]),
  ]);
  await assert.rejects(
    () =>
      new D1NotificationDeliveryIntentStore(malformedTarget).enqueue({
        envelope,
        queuedAt: QUEUED_AT,
      }),
    D1NotificationDeliveryIntentStoreError,
  );

  const multiple = new FakeD1Database([result(0), result(0, [storedRow(), storedRow()])]);
  await assert.rejects(
    () => new D1NotificationDeliveryIntentStore(multiple).enqueue({ envelope, queuedAt: QUEUED_AT }),
    D1NotificationDeliveryIntentStoreError,
  );
});

test("deterministic envelope and UTC timestamp validation happen before D1", async () => {
  const badIdentity = {
    ...envelope,
    deliveryId: "delivery-v1-0000000000000000",
  } as NotificationDeliveryEnvelope;
  const identityDatabase = new FakeD1Database([]);
  await assert.rejects(
    () =>
      new D1NotificationDeliveryIntentStore(identityDatabase).enqueue({
        envelope: badIdentity,
        queuedAt: QUEUED_AT,
      }),
    D1NotificationDeliveryIntentStoreError,
  );
  assert.equal(identityDatabase.prepared.length, 0);

  const timeDatabase = new FakeD1Database([]);
  await assert.rejects(
    () =>
      new D1NotificationDeliveryIntentStore(timeDatabase).enqueue({
        envelope,
        queuedAt: "2026-08-20T07:20:00+02:00",
      }),
    D1NotificationDeliveryIntentStoreError,
  );
  assert.equal(timeDatabase.prepared.length, 0);
});

test("0004 migration creates only an append-only bounded delivery intent identity registry", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "migrations/0004_notification_delivery_intents.sql"),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");

  try {
    database.exec(migration);

    const columns = database.prepare("PRAGMA table_info(notification_delivery_intents)").all() as Array<{
      name: string;
      pk: number;
    }>;
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "delivery_id",
        "schema_version",
        "transition_id",
        "target_key",
        "signal",
        "decision_id",
        "project_id",
        "reference",
        "title",
        "body",
        "deep_link_path",
        "queued_at",
      ],
    );
    assert.equal(columns.find((column) => column.name === "delivery_id")?.pk, 1);
    assert.doesNotMatch(
      columns.map((column) => column.name).join(" "),
      /telegram|web_push|token|secret|credential/i,
    );

    const insert = database.prepare(`
      INSERT INTO notification_delivery_intents (
        delivery_id, schema_version, transition_id, target_key, signal,
        decision_id, project_id, reference, title, body, deep_link_path, queued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const values = [
      envelope.deliveryId,
      1,
      envelope.transitionId,
      envelope.targetKey,
      envelope.signal,
      envelope.decisionId,
      envelope.projectId,
      envelope.reference,
      envelope.title,
      envelope.body,
      envelope.deepLinkPath,
      QUEUED_AT,
    ] as const;

    insert.run(...values);
    assert.throws(() => insert.run(...values));
    assert.throws(() =>
      insert.run(
        "delivery-v1-1111111111111111",
        1,
        envelope.transitionId,
        envelope.targetKey,
        envelope.signal,
        envelope.decisionId,
        envelope.projectId,
        envelope.reference,
        envelope.title,
        envelope.body,
        envelope.deepLinkPath,
        QUEUED_AT,
      ),
    );
    assert.throws(() =>
      insert.run(
        "delivery-v1-2222222222222222",
        1,
        "notification-v1-ci-failed-fedcba9876543210",
        "backup",
        "OTHER",
        envelope.decisionId,
        envelope.projectId,
        envelope.reference,
        envelope.title,
        envelope.body,
        envelope.deepLinkPath,
        QUEUED_AT,
      ),
    );
  } finally {
    database.close();
  }
});

test("delivery intent persistence is confined to dormant Cloudflare Queue runtime wiring", () => {
  const worker = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const queueRuntime = readFileSync(
    resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
    "utf8",
  );
  const reactApp = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
  const runtimePattern =
    /notification-delivery-intent-store|D1NotificationDeliveryIntentStore|notification_delivery_intents/;

  assert.match(queueRuntime, runtimePattern);
  assert.doesNotMatch(worker, runtimePattern);
  assert.doesNotMatch(reactApp, runtimePattern);
});
