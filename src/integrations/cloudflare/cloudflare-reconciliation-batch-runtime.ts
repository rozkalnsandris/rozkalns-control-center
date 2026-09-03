import { readCloudflareGitHubDashboardSnapshot } from "../github/cloudflare-dashboard-runtime.js";
import type { CloudflareGitHubRuntimeBindings } from "../github/cloudflare-worker-runtime.js";
import {
  createNotificationDeliveryDispatchQueueMessage,
  type NotificationDeliveryDispatchQueueMessageV1,
} from "../../shared/notification-delivery-dispatch-queue.js";
import type { NotificationDeliveryTargetKey } from "../../shared/notification-delivery.js";
import type {
  NotificationDeliveryIntentStore,
} from "../../shared/notification-delivery-intent-store.js";
import { reconcileNotificationTransitionDeliveries } from "../../shared/notification-transition-delivery-reconciliation.js";
import type { NotificationTransitionStore } from "../../shared/notification-transition-store.js";
import type { DeliveryLifecycleStore } from "./d1-delivery-claim-store.js";
import {
  consumeReconciliationQueueBatch,
  type QueueMessageBatchLike,
} from "./reconciliation-queue-batch-consumer.js";
import type { ReconciliationQueueConsumeResult } from "./reconciliation-queue-consumer.js";

export interface NotificationDispatchQueueProducerLike {
  send(message: NotificationDeliveryDispatchQueueMessageV1): Promise<void>;
}

export interface CloudflareNotificationDeliveryRuntimeOptions {
  readonly transitionStore: NotificationTransitionStore;
  readonly intentStore: NotificationDeliveryIntentStore;
  readonly targetKeys: readonly NotificationDeliveryTargetKey[];
  readonly dispatchQueue?: NotificationDispatchQueueProducerLike;
}

export interface CloudflareReconciliationBatchRuntimeOptions {
  readonly bindings: CloudflareGitHubRuntimeBindings;
  readonly deliveryStore: DeliveryLifecycleStore;
  readonly expectedQueue: string;
  readonly now?: () => string;
  readonly readDashboard?: typeof readCloudflareGitHubDashboardSnapshot;
  readonly notificationDelivery?: CloudflareNotificationDeliveryRuntimeOptions;
}

export type CloudflareReconciliationBatchHandler = (
  batch: QueueMessageBatchLike,
) => Promise<readonly ReconciliationQueueConsumeResult[]>;

function intentStoreWithDispatchQueue(
  options: CloudflareNotificationDeliveryRuntimeOptions,
): NotificationDeliveryIntentStore {
  if (!options.dispatchQueue) return options.intentStore;

  return {
    async enqueue(intent) {
      const result = await options.intentStore.enqueue(intent);

      // Queue only deterministic delivery identity after the durable intent
      // exists. Reconciliation replay may enqueue a duplicate Queue message;
      // downstream durable dispatch claims make that safe and never authorize a
      // second provider send.
      await options.dispatchQueue?.send(
        createNotificationDeliveryDispatchQueueMessage(intent.envelope.deliveryId),
      );
      return result;
    },
  };
}

/**
 * Build a Cloudflare Queue batch handler around the already-proven bounded live
 * dashboard read path.
 *
 * The expensive authoritative reread is created lazily by
 * consumeReconciliationQueueBatch and therefore runs at most once for the
 * entire Queue invocation. When an explicitly supplied notification-delivery
 * runtime is present, the same authoritative snapshot is reconciled through the
 * restart-safe provider-neutral transition→intent contract. An additionally
 * supplied dispatch Queue may receive deterministic delivery IDs only after each
 * durable intent enqueue succeeds; this invocation never calls a provider.
 */
export function createCloudflareReconciliationBatchHandler(
  options: CloudflareReconciliationBatchRuntimeOptions,
): CloudflareReconciliationBatchHandler {
  const now = options.now ?? (() => new Date().toISOString());
  const readDashboard = options.readDashboard ?? readCloudflareGitHubDashboardSnapshot;

  return (batch) =>
    consumeReconciliationQueueBatch(batch, {
      expectedQueue: options.expectedQueue,
      deliveryStore: options.deliveryStore,
      now,
      reconcileBatch: async () => {
        const observedAt = now();
        const snapshot = await readDashboard({
          bindings: options.bindings,
          observedAt,
        });
        if (options.notificationDelivery) {
          await reconcileNotificationTransitionDeliveries(
            {
              snapshot,
              observedAt,
              targetKeys: options.notificationDelivery.targetKeys,
            },
            options.notificationDelivery.transitionStore,
            intentStoreWithDispatchQueue(options.notificationDelivery),
          );
        }
      },
    });
}
