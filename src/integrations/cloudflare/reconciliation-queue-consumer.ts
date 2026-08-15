import {
  parseReconciliationQueueMessage,
  type ReconciliationQueueMessageV1,
} from "../../shared/reconciliation-queue.js";
import type {
  DeliveryLifecycleStore,
  DurableClaimedDelivery,
} from "./d1-delivery-claim-store.js";

export const RECONCILIATION_RETRY_ERROR_CODE = "AUTHORITATIVE_RECONCILIATION_FAILED" as const;
export const RECONCILIATION_DLQ_ERROR_CODE = "QUEUE_RETRY_EXHAUSTED" as const;

export interface QueueMessageControlLike {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export interface AuthoritativeReconciliationExecutor {
  reconcile(message: ReconciliationQueueMessageV1): Promise<void>;
}

export interface ReconciliationQueueConsumerDependencies {
  readonly deliveryStore: DeliveryLifecycleStore;
  readonly executor: AuthoritativeReconciliationExecutor;
  readonly now: () => string;
}

export interface ReconciliationDeadLetterDependencies {
  readonly deliveryStore: DeliveryLifecycleStore;
  readonly now: () => string;
}

export type ReconciliationQueueConsumeResult = "ACKED" | "RETRY_REQUESTED" | "TERMINAL_REPLAY";
export type ReconciliationDeadLetterResult = "DEAD_LETTERED" | "TERMINAL_REPLAY";

function assertExactDeliveryIdentity(
  message: ReconciliationQueueMessageV1,
  durable: DurableClaimedDelivery,
): void {
  if (
    durable.deliveryId !== message.deliveryId ||
    durable.repository !== message.repository ||
    durable.projectId !== message.projectId ||
    durable.eventName !== message.eventName ||
    durable.messageVersion !== message.schemaVersion ||
    durable.receivedAt !== message.receivedAt
  ) {
    throw new Error("Queue message identity does not match durable delivery state");
  }
}

function assertMainQueueProcessable(state: DurableClaimedDelivery["state"]): void {
  if (state !== "ENQUEUED" && state !== "RETRY_PENDING" && state !== "PROCESSING") {
    throw new Error(`Durable delivery state is not processable from the main queue: ${state}`);
  }
}

function assertDeadLetterFinalizable(state: DurableClaimedDelivery["state"]): void {
  if (state !== "ENQUEUED" && state !== "PROCESSING" && state !== "RETRY_PENDING") {
    throw new Error(`Durable delivery state is not eligible for dead-letter finalization: ${state}`);
  }
}

export async function consumeReconciliationQueueMessage(
  queueMessage: QueueMessageControlLike,
  dependencies: ReconciliationQueueConsumerDependencies,
): Promise<ReconciliationQueueConsumeResult> {
  const message = parseReconciliationQueueMessage(queueMessage.body);
  const durable = await dependencies.deliveryStore.readDelivery(message.deliveryId);
  assertExactDeliveryIdentity(message, durable);

  if (durable.state === "SUCCEEDED" || durable.state === "DEAD_LETTERED") {
    queueMessage.ack();
    return "TERMINAL_REPLAY";
  }

  assertMainQueueProcessable(durable.state);
  await dependencies.deliveryStore.markProcessing(message, dependencies.now());

  try {
    await dependencies.executor.reconcile(message);
  } catch {
    await dependencies.deliveryStore.markRetryPending(
      message,
      dependencies.now(),
      RECONCILIATION_RETRY_ERROR_CODE,
    );
    queueMessage.retry();
    return "RETRY_REQUESTED";
  }

  await dependencies.deliveryStore.markSucceeded(message, dependencies.now());
  queueMessage.ack();
  return "ACKED";
}

export async function finalizeReconciliationDeadLetter(
  queueMessage: QueueMessageControlLike,
  dependencies: ReconciliationDeadLetterDependencies,
): Promise<ReconciliationDeadLetterResult> {
  const message = parseReconciliationQueueMessage(queueMessage.body);
  const durable = await dependencies.deliveryStore.readDelivery(message.deliveryId);
  assertExactDeliveryIdentity(message, durable);

  if (durable.state === "SUCCEEDED" || durable.state === "DEAD_LETTERED") {
    queueMessage.ack();
    return "TERMINAL_REPLAY";
  }

  assertDeadLetterFinalizable(durable.state);
  await dependencies.deliveryStore.markDeadLettered(
    message,
    dependencies.now(),
    RECONCILIATION_DLQ_ERROR_CODE,
  );
  queueMessage.ack();
  return "DEAD_LETTERED";
}
