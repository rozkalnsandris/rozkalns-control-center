import { readCloudflareGitHubDashboardSnapshot } from "../github/cloudflare-dashboard-runtime.js";
import type { CloudflareGitHubRuntimeBindings } from "../github/cloudflare-worker-runtime.js";
import { reconcileNotificationTransitions } from "../../shared/notification-transition-reconciliation.js";
import type { NotificationTransitionStore } from "../../shared/notification-transition-store.js";
import type { DeliveryLifecycleStore } from "./d1-delivery-claim-store.js";
import {
  consumeReconciliationQueueBatch,
  type QueueMessageBatchLike,
} from "./reconciliation-queue-batch-consumer.js";
import type { ReconciliationQueueConsumeResult } from "./reconciliation-queue-consumer.js";

export interface CloudflareReconciliationBatchRuntimeOptions {
  readonly bindings: CloudflareGitHubRuntimeBindings;
  readonly deliveryStore: DeliveryLifecycleStore;
  readonly expectedQueue: string;
  readonly now?: () => string;
  readonly readDashboard?: typeof readCloudflareGitHubDashboardSnapshot;
  readonly notificationTransitionStore?: NotificationTransitionStore;
}

export type CloudflareReconciliationBatchHandler = (
  batch: QueueMessageBatchLike,
) => Promise<readonly ReconciliationQueueConsumeResult[]>;

/**
 * Build a Cloudflare Queue batch handler around the already-proven bounded live
 * dashboard read path.
 *
 * The expensive authoritative reread is created lazily by
 * consumeReconciliationQueueBatch and therefore runs at most once for the
 * entire Queue invocation. When an explicitly supplied notification transition
 * store is present, the same authoritative snapshot is also evaluated for the
 * provider-neutral high-signal transition contract. The durable claims record
 * discovery/dedupe only; this runtime does not send a notification provider
 * request.
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
        if (options.notificationTransitionStore) {
          await reconcileNotificationTransitions(
            snapshot,
            options.notificationTransitionStore,
            observedAt,
          );
        }
      },
    });
}
