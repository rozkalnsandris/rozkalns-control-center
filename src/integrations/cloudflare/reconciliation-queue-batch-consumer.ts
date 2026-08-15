import type { DeliveryLifecycleStore } from "./d1-delivery-claim-store.js";
import {
  consumeReconciliationQueueMessage,
  type AuthoritativeReconciliationExecutor,
  type QueueMessageControlLike,
  type ReconciliationQueueConsumeResult,
} from "./reconciliation-queue-consumer.js";

export interface QueueMessageBatchLike {
  readonly queue: string;
  readonly messages: readonly QueueMessageControlLike[];
}

export interface ReconciliationQueueBatchDependencies {
  readonly expectedQueue: string;
  readonly deliveryStore: DeliveryLifecycleStore;
  readonly reconcileBatch: () => Promise<void>;
  readonly now: () => string;
}

export class ReconciliationQueueBatchError extends Error {
  readonly failedMessageCount: number;

  constructor(failedMessageCount: number) {
    super("One or more reconciliation Queue messages were not explicitly settled");
    this.name = "ReconciliationQueueBatchError";
    this.failedMessageCount = failedMessageCount;
  }
}

function exactQueueName(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new ReconciliationQueueBatchError(0);
  }
  if (field === "batch.queue") return value;
  return value;
}

/**
 * Adapt Cloudflare MessageBatch semantics to the existing per-message durable
 * consumer while coalescing the expensive authoritative GitHub reread.
 *
 * Every message still owns its D1 state transition and explicit ack/retry. The
 * first processable message starts one shared reconciliation promise; every
 * other processable message in the same Queue invocation awaits that exact
 * promise. This keeps a full live dashboard reread bounded to one execution per
 * Queue invocation instead of one execution per message.
 *
 * Promise.allSettled is deliberate. A malformed/poison message must not stop a
 * valid sibling from reaching its own explicit Queue disposition. After all
 * siblings settle, the adapter rejects if any message remained unhandled. On
 * Cloudflare, explicit per-message ack/retry takes precedence over the later
 * batch-level failure, so only messages without an explicit disposition remain
 * eligible for batch retry.
 */
export async function consumeReconciliationQueueBatch(
  batch: QueueMessageBatchLike,
  dependencies: ReconciliationQueueBatchDependencies,
): Promise<readonly ReconciliationQueueConsumeResult[]> {
  const expectedQueue = exactQueueName(dependencies.expectedQueue, "expectedQueue");
  const actualQueue = exactQueueName(batch.queue, "batch.queue");
  if (actualQueue !== expectedQueue) {
    throw new ReconciliationQueueBatchError(batch.messages.length);
  }

  let sharedReconciliation: Promise<void> | null = null;
  const executor: AuthoritativeReconciliationExecutor = {
    async reconcile() {
      if (!sharedReconciliation) {
        sharedReconciliation = Promise.resolve().then(dependencies.reconcileBatch);
      }
      await sharedReconciliation;
    },
  };

  const settled = await Promise.allSettled(
    batch.messages.map((message) =>
      consumeReconciliationQueueMessage(message, {
        deliveryStore: dependencies.deliveryStore,
        executor,
        now: dependencies.now,
      }),
    ),
  );

  const failedMessageCount = settled.reduce(
    (count, result) => count + (result.status === "rejected" ? 1 : 0),
    0,
  );
  if (failedMessageCount > 0) {
    throw new ReconciliationQueueBatchError(failedMessageCount);
  }

  return settled.map((result) => {
    if (result.status !== "fulfilled") {
      throw new ReconciliationQueueBatchError(1);
    }
    return result.value;
  });
}
