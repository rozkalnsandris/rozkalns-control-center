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
  D1NotificationDeliveryAttemptStore,
  D1NotificationDeliveryAttemptStoreError,
} from "../src/integrations/cloudflare/d1-notification-delivery-attempt-store.js";
import type { NotificationDeliveryAttemptRecord } from "../src/shared/notification-delivery-attempt.js";
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

const DELIVERY_ID = "delivery-v1-0123456789abcdef";

function attempt(
  attemptNumber: number,
  resultValue: NotificationDeliveryAttemptRecord["result"],
  overrides: Partial<NotificationDeliveryAttemptRecord> = {},
): NotificationDeliveryAttemptRecord {
  return {
    schemaVersion: 1,
    deliveryId: DELIVERY_ID,
    attemptNumber,
    attemptedAt: `2026-08-20T06:${String(10 + attemptNumber).padStart(2, "0")}:00.000Z`,
    result: resultValue,
    ...overrides,
  };
}

function storedRow(
  value: NotificationDeliveryAttemptRecord,
  overrides: Partial<{
    delivery_id: string;
    attempt_number: number;
    schema_version: number;
    attempted_at: string;
    result_kind: string;
    result_reason: string | null;
  }> = {},
) {
  return {
    delivery_id: value.deliveryId,
    attempt_number: value.attemptNumber,
    schema_version: value.schemaVersion,
    attempted_at: value.attemptedAt,
    result_kind: value.result.kind,
    result_reason: value.result.kind === "DELIVERED" ? null : value.result.reason,
    ...overrides,
  };
}

test("first append reads empty history then writes one bounded provider-neutral attempt", async () => {
  const first = attempt(1, { kind: "RETRYABLE_FAILURE", reason: "TRANSIENT_UPSTREAM" });
  const database = new FakeD1Database([result(0), result(1)]);
  const store = new D1NotificationDeliveryAttemptStore(database);

  assert.deepEqual(await store.append(first), { kind: "APPENDED" });
  assert.equal(database.prepared.length, 2);
  assert.match(database.prepared[0].sql, /ORDER BY attempt_number ASC/);
  assert.deepEqual(database.prepared[0].values, [DELIVERY_ID]);
  assert.match(database.prepared[1].sql, /INSERT INTO notification_delivery_attempts/);
  assert.match(database.prepared[1].sql, /ON CONFLICT\(delivery_id, attempt_number\) DO NOTHING/);
  assert.doesNotMatch(database.prepared[1].sql, /telegram|web_push|token|secret|credential/i);
  assert.deepEqual(database.prepared[1].values, [
    DELIVERY_ID,
    1,
    1,
    first.attemptedAt,
    "RETRYABLE_FAILURE",
    "TRANSIENT_UPSTREAM",
  ]);
});

test("history is reconstructed through exact lifecycle order", async () => {
  const first = attempt(1, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" });
  const second = attempt(2, { kind: "DELIVERED" });
  const database = new FakeD1Database([result(0, [storedRow(first), storedRow(second)])]);

  const history = await new D1NotificationDeliveryAttemptStore(database).readHistory(DELIVERY_ID);
  assert.equal(history.status, "DELIVERED");
  assert.deepEqual(history.attempts, [first, second]);
});

test("exact durable replay returns duplicate but attempt-number drift fails closed", async () => {
  const first = attempt(1, { kind: "RETRYABLE_FAILURE", reason: "PROVIDER_UNAVAILABLE" });

  const duplicateDatabase = new FakeD1Database([result(0, [storedRow(first)])]);
  assert.deepEqual(await new D1NotificationDeliveryAttemptStore(duplicateDatabase).append(first), {
    kind: "DUPLICATE",
  });
  assert.equal(duplicateDatabase.prepared.length, 1);

  const driftDatabase = new FakeD1Database([result(0, [storedRow(first)])]);
  await assert.rejects(
    () =>
      new D1NotificationDeliveryAttemptStore(driftDatabase).append(
        attempt(1, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }),
      ),
    D1NotificationDeliveryAttemptStoreError,
  );
});

test("concurrent exact insert collision is re-read and accepted only when evidence matches", async () => {
  const first = attempt(1, { kind: "DELIVERED" });
  const exactDatabase = new FakeD1Database([
    result(0),
    result(0),
    result(0, [storedRow(first)]),
  ]);

  assert.deepEqual(await new D1NotificationDeliveryAttemptStore(exactDatabase).append(first), {
    kind: "DUPLICATE",
  });
  assert.equal(exactDatabase.prepared.length, 3);
  assert.match(exactDatabase.prepared[2].sql, /attempt_number = \?2/);

  const mismatchDatabase = new FakeD1Database([
    result(0),
    result(0),
    result(0, [storedRow(first, { attempted_at: "2026-08-20T06:59:00.000Z" })]),
  ]);
  await assert.rejects(
    () => new D1NotificationDeliveryAttemptStore(mismatchDatabase).append(first),
    D1NotificationDeliveryAttemptStoreError,
  );
});

test("gaps, malformed stored evidence and post-final history fail closed before append", async () => {
  const gap = attempt(2, { kind: "DELIVERED" });
  await assert.rejects(
    () => new D1NotificationDeliveryAttemptStore(new FakeD1Database([result(0)])).append(gap),
    D1NotificationDeliveryAttemptStoreError,
  );

  const malformed = new FakeD1Database([
    result(0, [
      storedRow(attempt(1, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }), {
        result_reason: "UNKNOWN_REASON",
      }),
    ]),
  ]);
  await assert.rejects(
    () => new D1NotificationDeliveryAttemptStore(malformed).readHistory(DELIVERY_ID),
    D1NotificationDeliveryAttemptStoreError,
  );

  const finalThenRetry = new FakeD1Database([
    result(0, [
      storedRow(attempt(1, { kind: "DELIVERED" })),
      storedRow(attempt(2, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" })),
    ]),
  ]);
  await assert.rejects(
    () => new D1NotificationDeliveryAttemptStore(finalThenRetry).readHistory(DELIVERY_ID),
    D1NotificationDeliveryAttemptStoreError,
  );
});

test("0005 migration adds only bounded attempt evidence linked to an existing delivery intent", () => {
  const migration0004 = readFileSync(
    resolve(process.cwd(), "migrations/0004_notification_delivery_intents.sql"),
    "utf8",
  );
  const migration0005 = readFileSync(
    resolve(process.cwd(), "migrations/0005_notification_delivery_attempts.sql"),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");

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

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migration0004);
    database.exec(migration0005);

    const columns = database.prepare("PRAGMA table_info(notification_delivery_attempts)").all() as Array<{
      name: string;
      pk: number;
    }>;
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "delivery_id",
        "attempt_number",
        "schema_version",
        "attempted_at",
        "result_kind",
        "result_reason",
      ],
    );
    assert.equal(columns.find((column) => column.name === "delivery_id")?.pk, 1);
    assert.equal(columns.find((column) => column.name === "attempt_number")?.pk, 2);
    assert.doesNotMatch(
      columns.map((column) => column.name).join(" "),
      /telegram|web_push|token|secret|credential/i,
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
      "2026-08-20T06:00:00.000Z",
    );

    const insert = database.prepare(`
      INSERT INTO notification_delivery_attempts (
        delivery_id, attempt_number, schema_version, attempted_at, result_kind, result_reason
      ) VALUES (?, ?, 1, ?, ?, ?)
    `);
    insert.run(
      envelope.deliveryId,
      1,
      "2026-08-20T06:11:00.000Z",
      "RETRYABLE_FAILURE",
      "RATE_LIMITED",
    );
    assert.throws(() =>
      insert.run(
        envelope.deliveryId,
        1,
        "2026-08-20T06:12:00.000Z",
        "DELIVERED",
        null,
      ),
    );
    assert.throws(() =>
      insert.run(
        envelope.deliveryId,
        9,
        "2026-08-20T06:13:00.000Z",
        "DELIVERED",
        null,
      ),
    );
    assert.throws(() =>
      insert.run(
        envelope.deliveryId,
        2,
        "2026-08-20T06:14:00.000Z",
        "RETRYABLE_FAILURE",
        "UNKNOWN_REASON",
      ),
    );
    assert.throws(() =>
      insert.run(
        "delivery-v1-fedcba9876543210",
        1,
        "2026-08-20T06:15:00.000Z",
        "DELIVERED",
        null,
      ),
    );
  } finally {
    database.close();
  }
});

test("attempt persistence remains detached from Worker and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /notification-delivery-attempt-store|D1NotificationDeliveryAttemptStore|notification_delivery_attempts/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
