import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlWebhookQueueRuntimeError,
  RECONCILIATION_DLQ_NAME,
  RECONCILIATION_QUEUE_NAME,
  resolveControlWebhookQueueRuntime,
  type ControlWebhookQueueRuntimeBindings,
} from "../src/integrations/cloudflare/control-webhook-queue-runtime.js";
import type {
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import type { QueueMessageControlLike } from "../src/integrations/cloudflare/reconciliation-queue-consumer.js";
import type { ReconciliationQueueMessageV1 } from "../src/shared/reconciliation-queue.js";

const RECEIVED_AT = "2026-08-15T12:00:00.000Z";
const NOW = "2026-08-15T12:30:00.000Z";

function reconciliationMessage(deliveryId: string): ReconciliationQueueMessageV1 {
  return {
    schemaVersion: 1,
    kind: "GITHUB_RECONCILIATION",
    deliveryId,
    eventName: "pull_request",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    receivedAt: RECEIVED_AT,
    authoritativeReadRequired: true,
  };
}

class FakeQueueMessage implements QueueMessageControlLike {
  readonly controls: string[] = [];

  constructor(readonly body: unknown) {}

  ack(): void {
    this.controls.push("ack");
  }

  retry(): void {
    this.controls.push("retry");
  }
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly repository: string;
  readonly project_id: string;
  readonly event_name: string;
  readonly message_version: number;
  readonly state: string;
  readonly attempt_count: number;
  readonly received_at: string;
  readonly enqueued_at: string | null;
  readonly processing_started_at: string | null;
  readonly last_attempt_at: string | null;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly dead_lettered_at: string | null;
  readonly last_error_code: string | null;
}

class RuntimeD1 {
  readonly queries: string[] = [];
  readonly rows = new Map<string, DeliveryRow>();

  prepare(query: string): D1PreparedStatementLike {
    this.queries.push(query);
    let values: readonly unknown[] = [];
    return {
      bind(...nextValues: readonly unknown[]) {
        values = nextValues;
        return this;
      },
      run: async <Row>(): Promise<D1RunResultLike<Row>> => {
        if (query.includes("FROM webhook_deliveries") && query.includes("WHERE delivery_id = ?1")) {
          const deliveryId = String(values[0]);
          const row = this.rows.get(deliveryId);
          return {
            success: true,
            meta: { changes: 0 },
            results: (row ? [row] : []) as unknown as readonly Row[],
          };
        }
        if (query.includes("state = 'DEAD_LETTERED'")) {
          const deliveryId = String(values[0]);
          const row = this.rows.get(deliveryId);
          if (!row) {
            return { success: true, meta: { changes: 0 }, results: [] } as D1RunResultLike<Row>;
          }
          this.rows.set(deliveryId, {
            ...row,
            state: "DEAD_LETTERED",
            dead_lettered_at: String(values[5]),
            updated_at: String(values[5]),
            last_error_code: String(values[4]),
          });
          return { success: true, meta: { changes: 1 }, results: [] } as D1RunResultLike<Row>;
        }
        throw new Error("unexpected fake D1 query");
      },
    };
  }
}

function deliveryRow(deliveryId: string, state: "ENQUEUED" | "SUCCEEDED"): DeliveryRow {
  return {
    delivery_id: deliveryId,
    repository: "rozkalnsandris/hermes-deals",
    project_id: "hermes-deals",
    event_name: "pull_request",
    message_version: 1,
    state,
    attempt_count: state === "SUCCEEDED" ? 1 : 0,
    received_at: RECEIVED_AT,
    enqueued_at: "2026-08-15T12:00:01.000Z",
    processing_started_at: state === "SUCCEEDED" ? "2026-08-15T12:00:02.000Z" : null,
    last_attempt_at: state === "SUCCEEDED" ? "2026-08-15T12:00:02.000Z" : null,
    updated_at: state === "SUCCEEDED" ? "2026-08-15T12:00:03.000Z" : "2026-08-15T12:00:01.000Z",
    completed_at: state === "SUCCEEDED" ? "2026-08-15T12:00:03.000Z" : null,
    dead_lettered_at: null,
    last_error_code: null,
  };
}

function enabledBindings(database: RuntimeD1): ControlWebhookQueueRuntimeBindings {
  return {
    CONTROL_WEBHOOK_RUNTIME_ENABLED: "true",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    CONTROL_DB: database,
    RECONCILIATION_QUEUE: {
      async send() {
        return undefined;
      },
    },
    GITHUB_APP_PRIVATE_KEY_PEM: "test-private-key-binding",
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_INSTALLATION_ID: "123",
  };
}

test("runtime flag must be exactly true before any other binding is inspected", () => {
  let inspected = 0;
  const bindings = {
    CONTROL_WEBHOOK_RUNTIME_ENABLED: "false",
    get CONTROL_DB() {
      inspected += 1;
      throw new Error("must stay dormant");
    },
    get GITHUB_WEBHOOK_SECRET() {
      inspected += 1;
      throw new Error("must stay dormant");
    },
  } as ControlWebhookQueueRuntimeBindings;

  assert.deepEqual(resolveControlWebhookQueueRuntime(bindings), { status: "DISABLED" });
  assert.equal(inspected, 0);
  assert.deepEqual(
    resolveControlWebhookQueueRuntime({ CONTROL_WEBHOOK_RUNTIME_ENABLED: "true " }),
    { status: "DISABLED" },
  );
});

test("exactly enabled but incomplete bindings fail closed without touching D1", () => {
  let prepares = 0;
  const resolution = resolveControlWebhookQueueRuntime({
    CONTROL_WEBHOOK_RUNTIME_ENABLED: "true",
    CONTROL_DB: {
      prepare() {
        prepares += 1;
        throw new Error("must not query");
      },
    },
  });

  assert.deepEqual(resolution, { status: "INVALID" });
  assert.equal(prepares, 0);
});

test("ready runtime rejects an unexpected queue before D1 or GitHub work", async () => {
  const database = new RuntimeD1();
  let dashboardReads = 0;
  const resolution = resolveControlWebhookQueueRuntime(enabledBindings(database), {
    now: () => NOW,
    readDashboard: async () => {
      dashboardReads += 1;
      return {} as never;
    },
  });
  assert.equal(resolution.status, "READY");
  if (resolution.status !== "READY") return;

  await assert.rejects(
    () => resolution.runtime.consumeQueueBatch({ queue: "unexpected", messages: [] }),
    (error: unknown) =>
      error instanceof ControlWebhookQueueRuntimeError && error.code === "UNEXPECTED_QUEUE",
  );
  assert.equal(database.queries.length, 0);
  assert.equal(dashboardReads, 0);
});

test("main queue terminal replay uses the existing batch consumer and skips authoritative reread", async () => {
  const database = new RuntimeD1();
  database.rows.set("delivery-main", deliveryRow("delivery-main", "SUCCEEDED"));
  let dashboardReads = 0;
  const resolution = resolveControlWebhookQueueRuntime(enabledBindings(database), {
    now: () => NOW,
    readDashboard: async () => {
      dashboardReads += 1;
      return {} as never;
    },
  });
  assert.equal(resolution.status, "READY");
  if (resolution.status !== "READY") return;

  const message = new FakeQueueMessage(reconciliationMessage("delivery-main"));
  assert.deepEqual(
    await resolution.runtime.consumeQueueBatch({
      queue: RECONCILIATION_QUEUE_NAME,
      messages: [message],
    }),
    ["TERMINAL_REPLAY"],
  );
  assert.deepEqual(message.controls, ["ack"]);
  assert.equal(dashboardReads, 0);
});

test("DLQ batch finalizes valid siblings before reporting a poison sibling", async () => {
  const database = new RuntimeD1();
  database.rows.set("delivery-dlq", deliveryRow("delivery-dlq", "ENQUEUED"));
  const resolution = resolveControlWebhookQueueRuntime(enabledBindings(database), {
    now: () => NOW,
    readDashboard: async () => ({} as never),
  });
  assert.equal(resolution.status, "READY");
  if (resolution.status !== "READY") return;

  const valid = new FakeQueueMessage(reconciliationMessage("delivery-dlq"));
  const poison = new FakeQueueMessage({ invalid: true });

  await assert.rejects(
    () =>
      resolution.runtime.consumeQueueBatch({
        queue: RECONCILIATION_DLQ_NAME,
        messages: [valid, poison],
      }),
    (error: unknown) =>
      error instanceof ControlWebhookQueueRuntimeError && error.code === "DLQ_BATCH_FAILED",
  );

  assert.deepEqual(valid.controls, ["ack"]);
  assert.deepEqual(poison.controls, []);
  assert.equal(database.rows.get("delivery-dlq")?.state, "DEAD_LETTERED");
  assert.equal(database.rows.get("delivery-dlq")?.last_error_code, "QUEUE_RETRY_EXHAUSTED");
});
