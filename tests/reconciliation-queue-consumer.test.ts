import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeliveryLifecycleStore,
  DurableClaimedDelivery,
  DurableDeliveryIdentity,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import {
  consumeReconciliationQueueMessage,
  finalizeReconciliationDeadLetter,
  RECONCILIATION_DLQ_ERROR_CODE,
  RECONCILIATION_RETRY_ERROR_CODE,
  type AuthoritativeReconciliationExecutor,
  type QueueMessageControlLike,
} from "../src/integrations/cloudflare/reconciliation-queue-consumer.js";
import type { ReconciliationQueueMessageV1 } from "../src/shared/reconciliation-queue.js";

const RECEIVED_AT = "2026-08-15T11:30:00.000Z";

function message(overrides: Partial<ReconciliationQueueMessageV1> = {}): ReconciliationQueueMessageV1 {
  return {
    schemaVersion: 1,
    kind: "GITHUB_RECONCILIATION",
    deliveryId: "delivery-144",
    eventName: "pull_request",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    receivedAt: RECEIVED_AT,
    authoritativeReadRequired: true,
    ...overrides,
  };
}

function durable(overrides: Partial<DurableClaimedDelivery> = {}): DurableClaimedDelivery {
  return {
    deliveryId: "delivery-144",
    eventName: "pull_request",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    messageVersion: 1,
    state: "ENQUEUED",
    attemptCount: 0,
    receivedAt: RECEIVED_AT,
    enqueuedAt: "2026-08-15T11:30:01.000Z",
    processingStartedAt: null,
    lastAttemptAt: null,
    updatedAt: "2026-08-15T11:30:01.000Z",
    completedAt: null,
    deadLetteredAt: null,
    lastErrorCode: null,
    ...overrides,
  };
}

class FakeLifecycleStore implements DeliveryLifecycleStore {
  readonly calls: string[] = [];
  readonly errorCodes: string[] = [];
  current: DurableClaimedDelivery;

  constructor(current: DurableClaimedDelivery) {
    this.current = current;
  }

  async readDelivery(deliveryId: string): Promise<DurableClaimedDelivery> {
    this.calls.push(`read:${deliveryId}`);
    return this.current;
  }

  async markProcessing(_delivery: DurableDeliveryIdentity, processingAt: string): Promise<void> {
    this.calls.push(`processing:${processingAt}`);
  }

  async markRetryPending(
    _delivery: DurableDeliveryIdentity,
    changedAt: string,
    errorCode: string,
  ): Promise<void> {
    this.errorCodes.push(errorCode);
    this.calls.push(`retry-pending:${changedAt}`);
  }

  async markSucceeded(_delivery: DurableDeliveryIdentity, completedAt: string): Promise<void> {
    this.calls.push(`succeeded:${completedAt}`);
  }

  async markDeadLettered(
    _delivery: DurableDeliveryIdentity,
    changedAt: string,
    errorCode: string,
  ): Promise<void> {
    this.errorCodes.push(errorCode);
    this.calls.push(`dead-lettered:${changedAt}`);
  }
}

class FakeQueueMessage implements QueueMessageControlLike {
  readonly controls: string[] = [];

  constructor(readonly body: unknown, readonly order: string[] = []) {}

  ack(): void {
    this.controls.push("ack");
    this.order.push("ack");
  }

  retry(): void {
    this.controls.push("retry");
    this.order.push("retry");
  }
}

function clock(...values: string[]): () => string {
  const pending = [...values];
  return () => {
    const value = pending.shift();
    if (!value) throw new Error("Unexpected clock read");
    return value;
  };
}

test("main Queue consumer durably completes before acknowledging", async () => {
  const order: string[] = [];
  const store = new FakeLifecycleStore(durable());
  store.markProcessing = async (_delivery, at) => {
    order.push(`processing:${at}`);
  };
  store.markSucceeded = async (_delivery, at) => {
    order.push(`succeeded:${at}`);
  };
  const executor: AuthoritativeReconciliationExecutor = {
    reconcile: async () => {
      order.push("authoritative-reread");
    },
  };
  const queueMessage = new FakeQueueMessage(message(), order);

  assert.equal(
    await consumeReconciliationQueueMessage(queueMessage, {
      deliveryStore: store,
      executor,
      now: clock("2026-08-15T11:31:00.000Z", "2026-08-15T11:31:01.000Z"),
    }),
    "ACKED",
  );

  assert.deepEqual(order, [
    "processing:2026-08-15T11:31:00.000Z",
    "authoritative-reread",
    "succeeded:2026-08-15T11:31:01.000Z",
    "ack",
  ]);
});

test("transient reconciliation failure is sanitized and durable before retry", async () => {
  const order: string[] = [];
  const store = new FakeLifecycleStore(durable());
  store.markProcessing = async () => {
    order.push("processing");
  };
  store.markRetryPending = async (_delivery, _at, errorCode) => {
    store.errorCodes.push(errorCode);
    order.push("retry-pending");
  };
  const executor: AuthoritativeReconciliationExecutor = {
    reconcile: async () => {
      order.push("authoritative-reread");
      throw new Error("token=must-never-be-persisted");
    },
  };
  const queueMessage = new FakeQueueMessage(message(), order);

  assert.equal(
    await consumeReconciliationQueueMessage(queueMessage, {
      deliveryStore: store,
      executor,
      now: clock("2026-08-15T11:32:00.000Z", "2026-08-15T11:32:01.000Z"),
    }),
    "RETRY_REQUESTED",
  );

  assert.deepEqual(order, ["processing", "authoritative-reread", "retry-pending", "retry"]);
  assert.deepEqual(store.errorCodes, [RECONCILIATION_RETRY_ERROR_CODE]);
  assert.doesNotMatch(store.errorCodes.join(" "), /token|must-never/i);
});

test("interrupted PROCESSING delivery is explicitly re-entered under at-least-once semantics", async () => {
  const store = new FakeLifecycleStore(durable({ state: "PROCESSING", attemptCount: 1 }));
  const queueMessage = new FakeQueueMessage(message());
  let executions = 0;

  assert.equal(
    await consumeReconciliationQueueMessage(queueMessage, {
      deliveryStore: store,
      executor: {
        reconcile: async () => {
          executions += 1;
        },
      },
      now: clock("2026-08-15T11:33:00.000Z", "2026-08-15T11:33:01.000Z"),
    }),
    "ACKED",
  );

  assert.equal(executions, 1);
  assert.match(store.calls.join("\n"), /processing:2026-08-15T11:33:00\.000Z/);
});

test("terminal main-queue replay is acknowledged without executing reconciliation", async () => {
  for (const state of ["SUCCEEDED", "DEAD_LETTERED"] as const) {
    const store = new FakeLifecycleStore(durable({ state }));
    const queueMessage = new FakeQueueMessage(message());
    let executions = 0;

    assert.equal(
      await consumeReconciliationQueueMessage(queueMessage, {
        deliveryStore: store,
        executor: {
          reconcile: async () => {
            executions += 1;
          },
        },
        now: () => {
          throw new Error("terminal replay must not consume clock");
        },
      }),
      "TERMINAL_REPLAY",
    );

    assert.equal(executions, 0);
    assert.deepEqual(queueMessage.controls, ["ack"]);
  }
});

test("identity mismatch and non-enqueued state fail closed without Queue control", async () => {
  const mismatched = new FakeLifecycleStore(durable({ repository: "rozkalnsandris/hermes-tech", projectId: "hermes-tech" }));
  const mismatchMessage = new FakeQueueMessage(message());
  await assert.rejects(
    () => consumeReconciliationQueueMessage(mismatchMessage, {
      deliveryStore: mismatched,
      executor: { reconcile: async () => undefined },
      now: () => "2026-08-15T11:34:00.000Z",
    }),
    /identity does not match/,
  );
  assert.deepEqual(mismatchMessage.controls, []);

  const received = new FakeLifecycleStore(durable({ state: "RECEIVED" }));
  const receivedMessage = new FakeQueueMessage(message());
  await assert.rejects(
    () => consumeReconciliationQueueMessage(receivedMessage, {
      deliveryStore: received,
      executor: { reconcile: async () => undefined },
      now: () => "2026-08-15T11:34:00.000Z",
    }),
    /not processable/,
  );
  assert.deepEqual(receivedMessage.controls, []);
});

test("DLQ finalizer durably records retry exhaustion before acknowledging", async () => {
  const order: string[] = [];
  const store = new FakeLifecycleStore(durable({ state: "RETRY_PENDING", attemptCount: 4 }));
  store.markDeadLettered = async (_delivery, _at, errorCode) => {
    store.errorCodes.push(errorCode);
    order.push("dead-lettered");
  };
  const queueMessage = new FakeQueueMessage(message(), order);

  assert.equal(
    await finalizeReconciliationDeadLetter(queueMessage, {
      deliveryStore: store,
      now: clock("2026-08-15T11:35:00.000Z"),
    }),
    "DEAD_LETTERED",
  );

  assert.deepEqual(order, ["dead-lettered", "ack"]);
  assert.deepEqual(store.errorCodes, [RECONCILIATION_DLQ_ERROR_CODE]);
});

test("DLQ finalizer supports infrastructure exhaustion before processing and terminal replay", async () => {
  const enqueued = new FakeLifecycleStore(durable({ state: "ENQUEUED" }));
  const enqueuedMessage = new FakeQueueMessage(message());
  assert.equal(
    await finalizeReconciliationDeadLetter(enqueuedMessage, {
      deliveryStore: enqueued,
      now: clock("2026-08-15T11:36:00.000Z"),
    }),
    "DEAD_LETTERED",
  );

  const terminal = new FakeLifecycleStore(durable({ state: "DEAD_LETTERED" }));
  const terminalMessage = new FakeQueueMessage(message());
  assert.equal(
    await finalizeReconciliationDeadLetter(terminalMessage, {
      deliveryStore: terminal,
      now: () => {
        throw new Error("terminal replay must not consume clock");
      },
    }),
    "TERMINAL_REPLAY",
  );
  assert.deepEqual(terminalMessage.controls, ["ack"]);
});

test("malformed Queue body fails before ack or retry", async () => {
  const store = new FakeLifecycleStore(durable());
  const queueMessage = new FakeQueueMessage({ ...message(), token: "forbidden" });

  await assert.rejects(
    () => consumeReconciliationQueueMessage(queueMessage, {
      deliveryStore: store,
      executor: { reconcile: async () => undefined },
      now: () => "2026-08-15T11:37:00.000Z",
    }),
    /Unsupported reconciliation queue message field: token/,
  );
  assert.deepEqual(queueMessage.controls, []);
});
