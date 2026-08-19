import type { CloudflareGitHubRuntimeBindings } from "../github/cloudflare-worker-runtime.js";
import { createCloudflareGitHubReadRuntime } from "../github/cloudflare-worker-runtime.js";
import {
  createCloudflareReconciliationBatchHandler,
  type CloudflareReconciliationBatchRuntimeOptions,
} from "./cloudflare-reconciliation-batch-runtime.js";
import {
  D1DeliveryClaimStore,
  type D1DatabaseLike,
} from "./d1-delivery-claim-store.js";
import { D1NotificationTransitionStore } from "./d1-notification-transition-store.js";
import {
  D1WebhookDeliveryObservabilityReader,
  type WebhookDeliveryObservabilityReader,
} from "./d1-delivery-observability-reader.js";
import type { QueueMessageBatchLike } from "./reconciliation-queue-batch-consumer.js";
import {
  finalizeReconciliationDeadLetter,
  type ReconciliationDeadLetterResult,
  type ReconciliationQueueConsumeResult,
} from "./reconciliation-queue-consumer.js";
import {
  WebhookReconciliationAcceptor,
  type ReconciliationQueueProducerLike,
} from "./webhook-reconciliation-acceptor.js";

export const CONTROL_WEBHOOK_RUNTIME_FLAG = "CONTROL_WEBHOOK_RUNTIME_ENABLED" as const;
export const CONTROL_NOTIFICATION_TRANSITIONS_FLAG = "CONTROL_NOTIFICATION_TRANSITIONS_ENABLED" as const;
export const RECONCILIATION_QUEUE_BINDING = "RECONCILIATION_QUEUE" as const;
export const GITHUB_WEBHOOK_SECRET_BINDING = "GITHUB_WEBHOOK_SECRET" as const;
export const RECONCILIATION_QUEUE_NAME = "rozkalns-control-reconciliation" as const;
export const RECONCILIATION_DLQ_NAME = "rozkalns-control-reconciliation-dlq" as const;

export interface ControlWebhookQueueRuntimeBindings {
  readonly CONTROL_WEBHOOK_RUNTIME_ENABLED?: unknown;
  readonly CONTROL_NOTIFICATION_TRANSITIONS_ENABLED?: unknown;
  readonly GITHUB_WEBHOOK_SECRET?: unknown;
  readonly CONTROL_DB?: unknown;
  readonly RECONCILIATION_QUEUE?: unknown;
  readonly GITHUB_APP_PRIVATE_KEY_PEM?: unknown;
  readonly GITHUB_APP_CLIENT_ID?: unknown;
  readonly GITHUB_APP_INSTALLATION_ID?: unknown;
}

export type ControlWebhookQueueRuntimeFailureCode =
  | "RUNTIME_UNAVAILABLE"
  | "UNEXPECTED_QUEUE"
  | "DLQ_BATCH_FAILED";

export class ControlWebhookQueueRuntimeError extends Error {
  readonly code: ControlWebhookQueueRuntimeFailureCode;

  constructor(code: ControlWebhookQueueRuntimeFailureCode) {
    super("Control webhook Queue runtime is unavailable");
    this.name = "ControlWebhookQueueRuntimeError";
    this.code = code;
  }
}

export interface ControlWebhookQueueRuntime {
  readonly webhookSecret: string;
  readonly webhookAcceptor: WebhookReconciliationAcceptor;
  readonly observabilityReader: WebhookDeliveryObservabilityReader;
  consumeQueueBatch(
    batch: QueueMessageBatchLike,
  ): Promise<readonly (ReconciliationQueueConsumeResult | ReconciliationDeadLetterResult)[]>;
}

export type ControlWebhookQueueRuntimeResolution =
  | { readonly status: "DISABLED" }
  | { readonly status: "INVALID" }
  | { readonly status: "READY"; readonly runtime: ControlWebhookQueueRuntime };

export interface ControlWebhookQueueRuntimeOptions {
  readonly now?: () => string;
  readonly readDashboard?: CloudflareReconciliationBatchRuntimeOptions["readDashboard"];
}

export function notificationTransitionsEnabled(value: unknown): boolean {
  return value === "true";
}

function bindingString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }
  return value;
}

function databaseBinding(value: unknown): D1DatabaseLike {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { readonly prepare?: unknown }).prepare !== "function"
  ) {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }
  return value as D1DatabaseLike;
}

function queueProducerBinding(value: unknown): ReconciliationQueueProducerLike {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { readonly send?: unknown }).send !== "function"
  ) {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }
  return value as ReconciliationQueueProducerLike;
}

function githubBindings(bindings: ControlWebhookQueueRuntimeBindings): CloudflareGitHubRuntimeBindings {
  return {
    GITHUB_APP_PRIVATE_KEY_PEM: bindingString(bindings.GITHUB_APP_PRIVATE_KEY_PEM),
    GITHUB_APP_CLIENT_ID: bindingString(bindings.GITHUB_APP_CLIENT_ID),
    GITHUB_APP_INSTALLATION_ID: bindingString(bindings.GITHUB_APP_INSTALLATION_ID),
  };
}

async function finalizeDeadLetterBatch(
  batch: QueueMessageBatchLike,
  deliveryStore: D1DeliveryClaimStore,
  now: () => string,
): Promise<readonly ReconciliationDeadLetterResult[]> {
  if (batch.queue !== RECONCILIATION_DLQ_NAME) {
    throw new ControlWebhookQueueRuntimeError("UNEXPECTED_QUEUE");
  }

  const settled = await Promise.allSettled(
    batch.messages.map((message) =>
      finalizeReconciliationDeadLetter(message, {
        deliveryStore,
        now,
      }),
    ),
  );
  const failedCount = settled.reduce(
    (count, result) => count + (result.status === "rejected" ? 1 : 0),
    0,
  );
  if (failedCount > 0) {
    throw new ControlWebhookQueueRuntimeError("DLQ_BATCH_FAILED");
  }

  return settled.map((result) => {
    if (result.status !== "fulfilled") {
      throw new ControlWebhookQueueRuntimeError("DLQ_BATCH_FAILED");
    }
    return result.value;
  });
}

/**
 * Resolve the Phase 2 webhook/Queue runtime plus an optional dormant-by-default
 * Phase 4 notification-transition discovery path.
 *
 * The webhook feature flag is checked before any other binding is inspected.
 * Notification transition discovery is enabled only by the exact literal
 * "true" and is otherwise absent from the Queue reconciliation path. Merely
 * merging this source does not activate the flag in production configuration.
 */
export function resolveControlWebhookQueueRuntime(
  bindings: ControlWebhookQueueRuntimeBindings,
  options: ControlWebhookQueueRuntimeOptions = {},
): ControlWebhookQueueRuntimeResolution {
  if (bindings.CONTROL_WEBHOOK_RUNTIME_ENABLED !== "true") {
    return { status: "DISABLED" };
  }

  try {
    const secret = bindingString(bindings.GITHUB_WEBHOOK_SECRET);
    const database = databaseBinding(bindings.CONTROL_DB);
    const queue = queueProducerBinding(bindings.RECONCILIATION_QUEUE);
    const github = githubBindings(bindings);

    // Validate the already-live read credentials before enabling any webhook
    // durability write path. Construction performs no GitHub request.
    createCloudflareGitHubReadRuntime({ bindings: github });

    const now = options.now ?? (() => new Date().toISOString());
    const deliveryStore = new D1DeliveryClaimStore(database);
    const notificationTransitionStore = notificationTransitionsEnabled(
      bindings.CONTROL_NOTIFICATION_TRANSITIONS_ENABLED,
    )
      ? new D1NotificationTransitionStore(database)
      : undefined;
    const webhookAcceptor = new WebhookReconciliationAcceptor({
      deliveryStore,
      queue,
      now,
    });
    const observabilityReader = new D1WebhookDeliveryObservabilityReader(database);
    const mainBatchHandler = createCloudflareReconciliationBatchHandler({
      bindings: github,
      deliveryStore,
      expectedQueue: RECONCILIATION_QUEUE_NAME,
      now,
      readDashboard: options.readDashboard,
      notificationTransitionStore,
    });

    return {
      status: "READY",
      runtime: {
        webhookSecret: secret,
        webhookAcceptor,
        observabilityReader,
        async consumeQueueBatch(batch) {
          if (batch.queue === RECONCILIATION_QUEUE_NAME) {
            return mainBatchHandler(batch);
          }
          if (batch.queue === RECONCILIATION_DLQ_NAME) {
            return finalizeDeadLetterBatch(batch, deliveryStore, now);
          }
          throw new ControlWebhookQueueRuntimeError("UNEXPECTED_QUEUE");
        },
      },
    };
  } catch {
    return { status: "INVALID" };
  }
}
