import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import type { NotificationDeliveryIntentRecoveryReader } from "../src/shared/notification-delivery-intent-store.js";
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
  rows: readonly Record<string, unknown>[] = [],
  success = true,
): D1RunResultLike {
  return { success, meta: { changes: 0 }, results: rows };
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
    schema_version: 1,
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

function asRecoveryReader(reader: NotificationDeliveryIntentRecoveryReader) {
  return reader;
}

test("restart-safe recovery returns the exact durable envelope and original queuedAt", async () => {
  const database = new FakeD1Database([result([storedRow()])]);
  const reader = asRecoveryReader(new D1NotificationDeliveryIntentStore(database));

  assert.deepEqual(await reader.read(envelope.deliveryId), {
    kind: "FOUND",
    intent: {
      envelope,
      queuedAt: QUEUED_AT,
    },
  });

  assert.equal(database.prepared.length, 1);
  assert.match(database.prepared[0].sql, /FROM notification_delivery_intents/);
  assert.match(database.prepared[0].sql, /WHERE delivery_id = \?1/);
  assert.deepEqual(database.prepared[0].values, [envelope.deliveryId]);
});

test("zero durable rows is the only valid NOT_FOUND evidence", async () => {
  const database = new FakeD1Database([result([])]);
  const reader = new D1NotificationDeliveryIntentStore(database);

  assert.deepEqual(await reader.read(envelope.deliveryId), { kind: "NOT_FOUND" });
});

test("malformed requested delivery identity fails before D1", async () => {
  const database = new FakeD1Database([]);
  const reader = new D1NotificationDeliveryIntentStore(database);

  await assert.rejects(
    () => reader.read("delivery-v1-not-valid"),
    D1NotificationDeliveryIntentStoreError,
  );
  assert.equal(database.prepared.length, 0);
});

test("stored identity drift and malformed durable evidence fail closed", async () => {
  const drift = new FakeD1Database([
    result([storedRow({ delivery_id: "delivery-v1-1111111111111111" })]),
  ]);
  await assert.rejects(
    () => new D1NotificationDeliveryIntentStore(drift).read(envelope.deliveryId),
    D1NotificationDeliveryIntentStoreError,
  );

  const schema = new FakeD1Database([result([storedRow({ schema_version: 2 })])]);
  await assert.rejects(
    () => new D1NotificationDeliveryIntentStore(schema).read(envelope.deliveryId),
    D1NotificationDeliveryIntentStoreError,
  );

  const queuedAt = new FakeD1Database([
    result([storedRow({ queued_at: "2026-08-20T07:20:00+02:00" })]),
  ]);
  await assert.rejects(
    () => new D1NotificationDeliveryIntentStore(queuedAt).read(envelope.deliveryId),
    D1NotificationDeliveryIntentStoreError,
  );

  const target = new FakeD1Database([result([storedRow({ target_key: "Primary target" })])]);
  await assert.rejects(
    () => new D1NotificationDeliveryIntentStore(target).read(envelope.deliveryId),
    D1NotificationDeliveryIntentStoreError,
  );
});

test("unconfirmed or ambiguous D1 recovery evidence fails closed", async () => {
  const failed = new FakeD1Database([result([], false)]);
  await assert.rejects(
    () => new D1NotificationDeliveryIntentStore(failed).read(envelope.deliveryId),
    D1NotificationDeliveryIntentStoreError,
  );

  const ambiguous = new FakeD1Database([result([storedRow(), storedRow()])]);
  await assert.rejects(
    () => new D1NotificationDeliveryIntentStore(ambiguous).read(envelope.deliveryId),
    D1NotificationDeliveryIntentStoreError,
  );
});

test("delivery intent recovery remains detached from Worker, Queue and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /NotificationDeliveryIntentRecoveryReader|notification-delivery-intent-recovery/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
