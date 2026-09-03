import type { CloudflareGitHubRuntimeBindings } from "../github/cloudflare-worker-runtime.js";
import { createCloudflareGitHubReadRuntime } from "../github/cloudflare-worker-runtime.js";
import { createTelegramNotificationDeliveryDispatchAdapter } from "../telegram/notification-delivery-dispatch-adapter.js";
import { NOTIFICATION_DELIVERY_INTENT_MAX_TARGETS } from "../../shared/notification-delivery-intent-materialization.js";
import type { NotificationDeliveryRetryPolicy } from "../../shared/notification-delivery-retry-policy.js";
import type { NotificationDeliveryTargetKey } from "../../shared/notification-delivery.js";
import {
  createCloudflareNotificationDispatchQueueRuntime,
  NOTIFICATION_DISPATCH_QUEUE_NAME,
  type CloudflareNotificationDispatchQueueRuntime,
  type NotificationDispatchQueueBatchLike,
  type NotificationDispatchQueueConsumeResult,
} from "./cloudflare-notification-dispatch-queue-runtime.js";
import {
  createCloudflareReconciliationBatchHandler,
  type CloudflareNotificationDeliveryRuntimeOptions,
  type CloudflareReconciliationBatchRuntimeOptions,
  type NotificationDispatchQueueProducerLike,
} from "./cloudflare-reconciliation-batch-runtime.js";
import {
  D1DeliveryClaimStore,
  type D1DatabaseLike,
} from "./d1-delivery-claim-store.js";
import { D1NotificationDeliveryIntentStore } from "./d1-notification-delivery-intent-store.js";
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
import { WebhookReconciliationAcceptor } from "./webhook-reconciliation-acceptor.js";

export const CONTROL_WEBHOOK_RUNTIME_FLAG = "CONTROL_WEBHOOK_RUNTIME_ENABLED" as const;
export const CONTROL_NOTIFICATION_TRANSITIONS_FLAG = "CONTROL_NOTIFICATION_TRANSITIONS_ENABLED" as const;
export const CONTROL_NOTIFICATION_TARGET_KEYS_BINDING = "CONTROL_NOTIFICATION_TARGET_KEYS" as const;
export const CONTROL_NOTIFICATION_DISPATCH_FLAG = "CONTROL_NOTIFICATION_DISPATCH_ENABLED" as const;
export const CONTROL_NOTIFICATION_RETRY_POLICY_BINDING = "CONTROL_NOTIFICATION_RETRY_POLICY" as const;
export const CONTROL_TELEGRAM_TARGET_KEY_BINDING = "CONTROL_TELEGRAM_TARGET_KEY" as const;
export const CONTROL_TELEGRAM_BOT_TOKEN_BINDING = "CONTROL_TELEGRAM_BOT_TOKEN" as const;
export const CONTROL_TELEGRAM_CHAT_ID_BINDING = "CONTROL_TELEGRAM_CHAT_ID" as const;
export const CONTROL_NOTIFICATION_CONTROL_ORIGIN_BINDING =
  "CONTROL_NOTIFICATION_CONTROL_ORIGIN" as const;
export const NOTIFICATION_DISPATCH_QUEUE_BINDING = "NOTIFICATION_DISPATCH_QUEUE" as const;
export const RECONCILIATION_QUEUE_BINDING = "RECONCILIATION_QUEUE" as const;
export const GITHUB_WEBHOOK_SECRET_BINDING = "GITHUB_WEBHOOK_SECRET" as const;
export const RECONCILIATION_QUEUE_NAME = "rozkalns-control-reconciliation" as const;
export const RECONCILIATION_DLQ_NAME = "rozkalns-control-reconciliation-dlq" as const;

export interface ControlWebhookQueueRuntimeBindings {
  readonly CONTROL_WEBHOOK_RUNTIME_ENABLED?: unknown;
  readonly CONTROL_NOTIFICATION_TRANSITIONS_ENABLED?: unknown;
  readonly CONTROL_NOTIFICATION_TARGET_KEYS?: unknown;
  readonly CONTROL_NOTIFICATION_DISPATCH_ENABLED?: unknown;
  readonly CONTROL_NOTIFICATION_RETRY_POLICY?: unknown;
  readonly CONTROL_TELEGRAM_TARGET_KEY?: unknown;
  readonly CONTROL_TELEGRAM_BOT_TOKEN?: unknown;
  readonly CONTROL_TELEGRAM_CHAT_ID?: unknown;
  readonly CONTROL_NOTIFICATION_CONTROL_ORIGIN?: unknown;
  readonly NOTIFICATION_DISPATCH_QUEUE?: unknown;
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
  ): Promise<
    readonly (
      | ReconciliationQueueConsumeResult
      | ReconciliationDeadLetterResult
      | NotificationDispatchQueueConsumeResult
    )[]
  >;
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

export function notificationDispatchEnabled(value: unknown): boolean {
  return value === "true";
}

const TARGET_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,63})$/;
const NOTIFICATION_MAX_ATTEMPTS = 8;
const NOTIFICATION_MAX_RETRY_DELAY_SECONDS = 86_400;

export function notificationTargetKeys(value: unknown): readonly NotificationDeliveryTargetKey[] {
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > NOTIFICATION_DELIVERY_INTENT_MAX_TARGETS
  ) {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }

  const targetKeys: NotificationDeliveryTargetKey[] = [];
  const seen = new Set<string>();
  for (const targetKey of parsed) {
    if (
      typeof targetKey !== "string" ||
      !TARGET_KEY_PATTERN.test(targetKey) ||
      seen.has(targetKey)
    ) {
      throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
    }
    seen.add(targetKey);
    targetKeys.push(targetKey);
  }

  return targetKeys;
}

export function notificationRetryPolicy(value: unknown): NotificationDeliveryRetryPolicy {
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }

  const candidate = parsed as {
    readonly schemaVersion?: unknown;
    readonly maxAttempts?: unknown;
    readonly retryDelaysSeconds?: unknown;
  };
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.maxAttempts !== "number" ||
    !Number.isSafeInteger(candidate.maxAttempts) ||
    candidate.maxAttempts < 1 ||
    candidate.maxAttempts > NOTIFICATION_MAX_ATTEMPTS ||
    !Array.isArray(candidate.retryDelaysSeconds) ||
    candidate.retryDelaysSeconds.length !== candidate.maxAttempts - 1
  ) {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }

  const retryDelaysSeconds: number[] = [];
  for (const delay of candidate.retryDelaysSeconds) {
    if (
      typeof delay !== "number" ||
      !Number.isSafeInteger(delay) ||
      delay < 1 ||
      delay > NOTIFICATION_MAX_RETRY_DELAY_SECONDS
    ) {
      throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
    }
    retryDelaysSeconds.push(delay);
  }

  return {
    schemaVersion: 1,
    maxAttempts: candidate.maxAttempts,
    retryDelaysSeconds,
  };
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

interface QueueProducerBindingLike {
  send(message: unknown): Promise<void>;
}

function queueProducerBinding(value: unknown): QueueProducerBindingLike {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { readonly send?: unknown }).send !== "function"
  ) {
    throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
  }
  return value as QueueProducerBindingLike;
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
 * Resolve the Phase 2 webhook/Queue runtime plus optional dormant-by-default
 * Phase 4 notification intent and Telegram dispatch paths.
 *
 * Provider dispatch requires two exact opt-ins: transition durability and
 * dispatch. When dispatch is absent/off, no Telegram credential/destination or
 * dispatch Queue binding is inspected. Even when source is merged, production
 * remains dormant until those bindings and Queue topology are separately
 * configured and deployed.
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
    const reconciliationQueue = queueProducerBinding(bindings.RECONCILIATION_QUEUE);
    const github = githubBindings(bindings);

    // Validate the already-live read credentials before enabling any webhook
    // durability write path. Construction performs no GitHub request.
    createCloudflareGitHubReadRuntime({ bindings: github });

    const now = options.now ?? (() => new Date().toISOString());
    const deliveryStore = new D1DeliveryClaimStore(database);
    const transitionsEnabled = notificationTransitionsEnabled(
      bindings.CONTROL_NOTIFICATION_TRANSITIONS_ENABLED,
    );
    const dispatchEnabled = notificationDispatchEnabled(
      bindings.CONTROL_NOTIFICATION_DISPATCH_ENABLED,
    );
    if (dispatchEnabled && !transitionsEnabled) {
      throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
    }

    let notificationDelivery: CloudflareNotificationDeliveryRuntimeOptions | undefined;
    let notificationDispatchRuntime: CloudflareNotificationDispatchQueueRuntime | undefined;

    if (transitionsEnabled) {
      const targetKeys = notificationTargetKeys(bindings.CONTROL_NOTIFICATION_TARGET_KEYS);
      const transitionStore = new D1NotificationTransitionStore(database);
      const intentStore = new D1NotificationDeliveryIntentStore(database);

      notificationDelivery = {
        transitionStore,
        intentStore,
        targetKeys,
      };

      if (dispatchEnabled) {
        const targetKey = bindingString(bindings.CONTROL_TELEGRAM_TARGET_KEY);
        if (targetKeys.length !== 1 || targetKeys[0] !== targetKey) {
          throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
        }

        const dispatchQueue = queueProducerBinding(
          bindings.NOTIFICATION_DISPATCH_QUEUE,
        ) as NotificationDispatchQueueProducerLike;
        const retryPolicy = notificationRetryPolicy(
          bindings.CONTROL_NOTIFICATION_RETRY_POLICY,
        );
        const adapter = createTelegramNotificationDeliveryDispatchAdapter({
          targetKey,
          botToken: bindingString(bindings.CONTROL_TELEGRAM_BOT_TOKEN),
          chatId: bindingString(bindings.CONTROL_TELEGRAM_CHAT_ID),
          controlOrigin: bindingString(bindings.CONTROL_NOTIFICATION_CONTROL_ORIGIN),
        });

        notificationDelivery = {
          ...notificationDelivery,
          dispatchQueue,
        };
        notificationDispatchRuntime = createCloudflareNotificationDispatchQueueRuntime({
          database,
          adapter,
          retryPolicy,
          now,
        });
      }
    }

    const webhookAcceptor = new WebhookReconciliationAcceptor({
      deliveryStore,
      queue: reconciliationQueue,
      now,
    });
    const observabilityReader = new D1WebhookDeliveryObservabilityReader(database);
    const mainBatchHandler = createCloudflareReconciliationBatchHandler({
      bindings: github,
      deliveryStore,
      expectedQueue: RECONCILIATION_QUEUE_NAME,
      now,
      readDashboard: options.readDashboard,
      notificationDelivery,
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
          if (batch.queue === NOTIFICATION_DISPATCH_QUEUE_NAME) {
            if (!notificationDispatchRuntime) {
              throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
            }
            return notificationDispatchRuntime.consumeQueueBatch(
              batch as unknown as NotificationDispatchQueueBatchLike,
            );
          }
          throw new ControlWebhookQueueRuntimeError("UNEXPECTED_QUEUE");
        },
      },
    };
  } catch {
    return { status: "INVALID" };
  }
}
