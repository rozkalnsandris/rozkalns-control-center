import { readCloudflareGitHubDashboardSnapshot } from "../github/cloudflare-dashboard-runtime.js";
import type { CloudflareGitHubRuntimeBindings } from "../github/cloudflare-worker-runtime.js";
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
}

export type CloudflareReconciliationBatchHandler = (
  batch: QueueMessageBatchLike,
) => Promise<readonly ReconciliationQueueConsumeResult[]>;

/**
 * Build a source-only Cloudflare Queue batch handler around the already-proven
 * bounded live dashboard read path.
 *
 * The expensive authoritative reread is created lazily by
 * consumeReconciliationQueueBatch and therefore runs at most once for the
 * entire Queue invocation. The returned dashboard snapshot is intentionally
 * not persisted here: the current Phase 2 UI reads GitHub live, while D1 owns
 * delivery lifecycle evidence only.
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
        await readDashboard({
          bindings: options.bindings,
          observedAt,
        });
      },
    });
}
