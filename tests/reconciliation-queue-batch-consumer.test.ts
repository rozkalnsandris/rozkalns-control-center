import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudflareReconciliationBatchHandler,
} from "../src/integrations/cloudflare/cloudflare-reconciliation-batch-runtime.js";
import type {
  DeliveryLifecycleStore,
  DurableClaimedDelivery,
  DurableDeliveryIdentity,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import {
  consumeReconciliationQueueBatch,
  ReconciliationQueueBatchError,
} from "../src/integrations/cloudflare/reconciliation-queue-batch-consumer.js";
import type { QueueMessageControlLike } from "../src/integrations/cloudflare/reconciliation-queue-consumer.js";
import type { ReconciliationQueueMessageV1 } from "../src/shared/reconciliation-queue.js";

const QUEUE_NAME = "rozkalns-control-reconciliation";
const NOW = "2026-08-15T12:10:00.000Z";
const RECEIVED_AT = "2026-08-15T12:00:00.000Z";

function message(
  deliveryId: string,
  overrides: Partial<ReconciliationQueueMessageV1> = {},
): ReconciliationQueueMessageV1 {
  return {
    schemaVersion: 1,
    kind: "GITHUB_RECONCILIATION",
    deliveryId,
    eventName: "pull_request",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    receivedAt: RECEIVED_AT,
    authoritativeReadRequired: true,
    ...overrides,
  };
}

function durable(
  deliveryId: string,
  overrides: Partial<DurableClaimedDelivery> = {},
): DurableClaimedDelivery {
  return {
    deliveryId,
    eventName: "pull_request",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    messageVersion: 1,
    state: "ENQUEUED",
    attemptCount: 0,
    receivedAt: RECEIVED_AT,
    enqueuedAt: "2026-08-15T12:00:01.000Z",
    processingStartedAt: null,
    lastAttemptAt: null,
    updatedAt: "2026-08-15T12:00:01.000Z",
    completedAt: null,
    deadLetteredAt: null,
    lastErrorCode: null,
    ...overrides,
  };
}

class MapLifecycleStore implements DeliveryLifecycleStore {
  readonly calls: string[] = [];
  readonly records = new Map<string, DurableClaimedDelivery>();

  constructor(records: readonly DurableClaimedDelivery[]) {
    for (const record of records) this.records.set(record.deliveryId, record);
  }

  async readDelivery(deliveryId: string): Promise<DurableClaimedDelivery> {
    this.calls.push(`read:${deliveryId}`);
    const record = this.records.get(deliveryId);
    if (!record) throw new Error("missing fake delivery");
    return record;
  }

  async markProcessing(delivery: DurableDeliveryIdentity, processingAt: string): Promise<void> {
    this.calls.push(`processing:${delivery.deliveryId}`);
    const current = await this.readDelivery(delivery.deliveryId);
    this.records.set(delivery.deliveryId, {
      ...current,
      state: "PROCESSING",
      attemptCount: current.attemptCount + 1,
      processingStartedAt: processingAt,
      lastAttemptAt: processingAt,
      updatedAt: processingAt,
    });
  }

  async markRetryPending(
    delivery: DurableDeliveryIdentity,
    changedAt: string,
    errorCode: string,
  ): Promise<void> {
    this.calls.push(`retry:${delivery.deliveryId}:${errorCode}`);
    const current = await this.readDelivery(delivery.deliveryId);
    this.records.set(delivery.deliveryId, {
      ...current,
      state: "RETRY_PENDING",
      updatedAt: changedAt,
      lastErrorCode: errorCode,
    });
  }

  async markSucceeded(delivery: DurableDeliveryIdentity, completedAt: string): Promise<void> {
    this.calls.push(`succeeded:${delivery.deliveryId}`);
    const current = await this.readDelivery(delivery.deliveryId);
    this.records.set(delivery.deliveryId, {
      ...current,
      state: "SUCCEEDED",
      updatedAt: completedAt,
      completedAt,
      lastErrorCode: null,
    });
  }

  async markDeadLettered(
    delivery: DurableDeliveryIdentity,
    changedAt: string,
    errorCode: string,
  ): Promise<void> {
    this.calls.push(`dead-lettered:${delivery.deliveryId}:${errorCode}`);
    const current = await this.readDelivery(delivery.deliveryId);
    this.records.set(delivery.deliveryId, {
      ...current,
      state: "DEAD_LETTERED",
      updatedAt: changedAt,
      deadLetteredAt: changedAt,
      lastErrorCode: errorCode,
    });
  }
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

function fixedNow(): string {
  return NOW;
}

test("multiple valid Queue messages share exactly one authoritative reread", async () => {
  const first = new FakeQueueMessage(message("delivery-a"));
  const second = new FakeQueueMessage(message("delivery-b"));
  const store = new MapLifecycleStore([durable("delivery-a"), durable("delivery-b")]);
  let rereads = 0;

  const result = await consumeReconciliationQueueBatch(
    { queue: QUEUE_NAME, messages: [first, second] },
    {
      expectedQueue: QUEUE_NAME,
      deliveryStore: store,
      reconcileBatch: async () => {
        rereads += 1;
      },
      now: fixedNow,
    },
  );

  assert.deepEqual(result, ["ACKED", "ACKED"]);
  assert.equal(rereads, 1);
  assert.deepEqual(first.controls, ["ack"]);
  assert.deepEqual(second.controls, ["ack"]);
  assert.equal(store.records.get("delivery-a")?.state, "SUCCEEDED");
  assert.equal(store.records.get("delivery-b")?.state, "SUCCEEDED");
});

test("one shared reread failure durably requests retry for every processable sibling", async () => {
  const first = new FakeQueueMessage(message("delivery-a"));
  const second = new FakeQueueMessage(message("delivery-b"));
  const store = new MapLifecycleStore([durable("delivery-a"), durable("delivery-b")]);
  let rereads = 0;

  const result = await consumeReconciliationQueueBatch(
    { queue: QUEUE_NAME, messages: [first, second] },
    {
      expectedQueue: QUEUE_NAME,
      deliveryStore: store,
      reconcileBatch: async () => {
        rereads += 1;
        throw new Error("secret transport detail must not escape to D1");
      },
      now: fixedNow,
    },
  );

  assert.deepEqual(result, ["RETRY_REQUESTED", "RETRY_REQUESTED"]);
  assert.equal(rereads, 1);
  assert.deepEqual(first.controls, ["retry"]);
  assert.deepEqual(second.controls, ["retry"]);
  assert.equal(store.records.get("delivery-a")?.state, "RETRY_PENDING");
  assert.equal(store.records.get("delivery-b")?.state, "RETRY_PENDING");
  assert.equal(store.records.get("delivery-a")?.lastErrorCode, "AUTHORITATIVE_RECONCILIATION_FAILED");
  assert.equal(store.records.get("delivery-b")?.lastErrorCode, "AUTHORITATIVE_RECONCILIATION_FAILED");
});

test("terminal replays are individually acknowledged without starting the shared reread", async () => {
  const succeeded = new FakeQueueMessage(message("delivery-a"));
  const deadLettered = new FakeQueueMessage(message("delivery-b"));
  const store = new MapLifecycleStore([
    durable("delivery-a", { state: "SUCCEEDED", completedAt: NOW }),
    durable("delivery-b", { state: "DEAD_LETTERED", deadLetteredAt: NOW, lastErrorCode: "QUEUE_RETRY_EXHAUSTED" }),
  ]);
  let rereads = 0;

  const result = await consumeReconciliationQueueBatch(
    { queue: QUEUE_NAME, messages: [succeeded, deadLettered] },
    {
      expectedQueue: QUEUE_NAME,
      deliveryStore: store,
      reconcileBatch: async () => {
        rereads += 1;
      },
      now: () => {
        throw new Error("terminal replay must not consume clock");
      },
    },
  );

  assert.deepEqual(result, ["TERMINAL_REPLAY", "TERMINAL_REPLAY"]);
  assert.equal(rereads, 0);
  assert.deepEqual(succeeded.controls, ["ack"]);
  assert.deepEqual(deadLettered.controls, ["ack"]);
});

test("poison message does not prevent a valid sibling from reaching explicit ack", async () => {
  const valid = new FakeQueueMessage(message("delivery-a"));
  const poison = new FakeQueueMessage({ ...message("delivery-poison"), token: "forbidden" });
  const store = new MapLifecycleStore([durable("delivery-a")]);
  let rereads = 0;

  await assert.rejects(
    () =>
      consumeReconciliationQueueBatch(
        { queue: QUEUE_NAME, messages: [valid, poison] },
        {
          expectedQueue: QUEUE_NAME,
          deliveryStore: store,
          reconcileBatch: async () => {
            rereads += 1;
          },
          now: fixedNow,
        },
      ),
    (error: unknown) =>
      error instanceof ReconciliationQueueBatchError && error.failedMessageCount === 1,
  );

  assert.equal(rereads, 1);
  assert.deepEqual(valid.controls, ["ack"]);
  assert.deepEqual(poison.controls, []);
  assert.equal(store.records.get("delivery-a")?.state, "SUCCEEDED");
});

test("empty batches are a no-op and unexpected Queue names fail before processing", async () => {
  const store = new MapLifecycleStore([]);
  let rereads = 0;

  assert.deepEqual(
    await consumeReconciliationQueueBatch(
      { queue: QUEUE_NAME, messages: [] },
      {
        expectedQueue: QUEUE_NAME,
        deliveryStore: store,
        reconcileBatch: async () => {
          rereads += 1;
        },
        now: fixedNow,
      },
    ),
    [],
  );
  assert.equal(rereads, 0);

  const messageControl = new FakeQueueMessage(message("delivery-a"));
  await assert.rejects(
    () =>
      consumeReconciliationQueueBatch(
        { queue: "unexpected-queue", messages: [messageControl] },
        {
          expectedQueue: QUEUE_NAME,
          deliveryStore: new MapLifecycleStore([durable("delivery-a")]),
          reconcileBatch: async () => undefined,
          now: fixedNow,
        },
      ),
    ReconciliationQueueBatchError,
  );
  assert.deepEqual(messageControl.controls, []);
});

test("Cloudflare runtime wrapper invokes the bounded live dashboard reader once per batch", async () => {
  const first = new FakeQueueMessage(message("delivery-a"));
  const second = new FakeQueueMessage(message("delivery-b"));
  const store = new MapLifecycleStore([durable("delivery-a"), durable("delivery-b")]);
  const observations: string[] = [];
  let reads = 0;

  const handleBatch = createCloudflareReconciliationBatchHandler({
    bindings: {
      GITHUB_APP_PRIVATE_KEY_PEM: "test-only-private-key-binding",
      GITHUB_APP_CLIENT_ID: "test-client-id",
      GITHUB_APP_INSTALLATION_ID: "123",
    },
    deliveryStore: store,
    expectedQueue: QUEUE_NAME,
    now: fixedNow,
    readDashboard: async (options) => {
      reads += 1;
      observations.push(options.observedAt);
      return {} as never;
    },
  });

  assert.deepEqual(
    await handleBatch({ queue: QUEUE_NAME, messages: [first, second] }),
    ["ACKED", "ACKED"],
  );
  assert.equal(reads, 1);
  assert.deepEqual(observations, [NOW]);
});
