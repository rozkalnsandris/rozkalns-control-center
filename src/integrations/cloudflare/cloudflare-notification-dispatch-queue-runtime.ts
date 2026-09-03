import {
  coordinateNotificationDeliveryDispatch,
  type NotificationDeliveryDispatchCoordinatorResult,
} from "../../shared/notification-delivery-dispatch-coordinator.js";
import type { NotificationDeliveryDispatchAdapter } from "../../shared/notification-delivery-dispatch-attempt.js";
import type {
  NotificationDeliveryDispatchClaimRecoveryReader,
  NotificationDeliveryDispatchClaimStore,
} from "../../shared/notification-delivery-dispatch-claim-store.js";
import { planNotificationDeliveryDispatch } from "../../shared/notification-delivery-dispatch-plan.js";
import {
  parseNotificationDeliveryDispatchQueueMessage,
} from "../../shared/notification-delivery-dispatch-queue.js";
import type { NotificationDeliveryRetryPolicy } from "../../shared/notification-delivery-retry-policy.js";
import type { NotificationDeliveryAttemptStore } from "../../shared/notification-delivery-attempt-store.js";
import type { NotificationDeliveryIntentRecoveryReader } from "../../shared/notification-delivery-intent-store.js";
import { D1NotificationDeliveryAttemptStore } from "./d1-notification-delivery-attempt-store.js";
import { D1NotificationDeliveryDispatchClaimStore } from "./d1-notification-delivery-dispatch-claim-store.js";
import { D1NotificationDeliveryIntentStore } from "./d1-notification-delivery-intent-store.js";
import type { D1DatabaseLike } from "./d1-delivery-claim-store.js";

export const NOTIFICATION_DISPATCH_QUEUE_NAME =
  "rozkalns-control-notification-dispatch" as const;
export const NOTIFICATION_DISPATCH_MAX_RETRY_DELAY_SECONDS = 86_400 as const;

export interface NotificationDispatchQueueMessageControlLike {
  readonly body: unknown;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface NotificationDispatchQueueBatchLike {
  readonly queue: string;
  readonly messages: readonly NotificationDispatchQueueMessageControlLike[];
}

export type NotificationDispatchQueueConsumeResult =
  | "ACKED"
  | "RETRY_REQUESTED"
  | "AMBIGUOUS_ACKED";

export type NotificationDispatchQueueRuntimeErrorCode =
  | "UNEXPECTED_QUEUE"
  | "BATCH_FAILED"
  | "INTENT_NOT_FOUND"
  | "INVALID_RETRY_STATE";

export class NotificationDispatchQueueRuntimeError extends Error {
  readonly code: NotificationDispatchQueueRuntimeErrorCode;

  constructor(code: NotificationDispatchQueueRuntimeErrorCode) {
    super("Notification dispatch Queue runtime failed closed");
    this.name = "NotificationDispatchQueueRuntimeError";
    this.code = code;
  }
}

type DispatchClaimRuntime = NotificationDeliveryDispatchClaimStore &
  NotificationDeliveryDispatchClaimRecoveryReader;

export interface NotificationDispatchQueueConsumerDependencies {
  readonly intentReader: NotificationDeliveryIntentRecoveryReader;
  readonly attemptStore: NotificationDeliveryAttemptStore;
  readonly claimStore: DispatchClaimRuntime;
  readonly adapter: NotificationDeliveryDispatchAdapter;
  readonly retryPolicy: NotificationDeliveryRetryPolicy;
  readonly now: () => string;
}

export interface CloudflareNotificationDispatchQueueRuntime {
  consumeQueueBatch(
    batch: NotificationDispatchQueueBatchLike,
  ): Promise<readonly NotificationDispatchQueueConsumeResult[]>;
}

export interface CloudflareNotificationDispatchQueueRuntimeOptions {
  readonly database: D1DatabaseLike;
  readonly adapter: NotificationDeliveryDispatchAdapter;
  readonly retryPolicy: NotificationDeliveryRetryPolicy;
  readonly now?: () => string;
}

function retryDelaySeconds(observedAt: string, eligibleAt: string): number {
  const delay = Math.ceil((Date.parse(eligibleAt) - Date.parse(observedAt)) / 1_000);
  if (!Number.isSafeInteger(delay) || delay < 1) {
    throw new NotificationDispatchQueueRuntimeError("INVALID_RETRY_STATE");
  }
  return Math.min(delay, NOTIFICATION_DISPATCH_MAX_RETRY_DELAY_SECONDS);
}

async function readDispatchPlan(
  deliveryId: string,
  observedAt: string,
  dependencies: NotificationDispatchQueueConsumerDependencies,
) {
  const plan = await planNotificationDeliveryDispatch(
    deliveryId,
    observedAt,
    dependencies.retryPolicy,
    {
      intentReader: dependencies.intentReader,
      attemptHistoryReader: dependencies.attemptStore,
    },
  );
  if (plan.kind !== "FOUND") {
    throw new NotificationDispatchQueueRuntimeError("INTENT_NOT_FOUND");
  }
  return plan;
}

function settleDecisionWithoutProvider(
  message: NotificationDispatchQueueMessageControlLike,
  decision: Awaited<ReturnType<typeof readDispatchPlan>>["decision"],
  observedAt: string,
): NotificationDispatchQueueConsumeResult | null {
  if (decision.kind === "WAIT") {
    message.retry({
      delaySeconds: retryDelaySeconds(observedAt, decision.eligibleAt),
    });
    return "RETRY_REQUESTED";
  }

  if (
    decision.kind === "DELIVERED" ||
    decision.kind === "TERMINAL_FAILURE" ||
    decision.kind === "EXHAUSTED"
  ) {
    message.ack();
    return "ACKED";
  }

  return null;
}

function settleCoordinatorResult(
  message: NotificationDispatchQueueMessageControlLike,
  result: NotificationDeliveryDispatchCoordinatorResult,
): NotificationDispatchQueueConsumeResult | null {
  if (result.kind === "AMBIGUOUS_CLAIMED") {
    // A durable claim without exact result evidence is a replay barrier. Ack the
    // Queue message so queue redelivery cannot become resend permission.
    message.ack();
    return "AMBIGUOUS_ACKED";
  }

  if (result.result.kind === "DELIVERED" || result.result.kind === "TERMINAL_FAILURE") {
    message.ack();
    return "ACKED";
  }

  return null;
}

/**
 * Consume one deterministic notification dispatch message.
 *
 * Durable intent + attempt evidence is planned before a provider boundary. Only
 * READY may enter the restart-safe coordinator. WAIT uses an explicit delayed
 * Queue retry; delivered/terminal/exhausted and ambiguous-claimed evidence are
 * acknowledged without another provider invocation.
 */
export async function consumeNotificationDeliveryDispatchQueueMessage(
  queueMessage: NotificationDispatchQueueMessageControlLike,
  dependencies: NotificationDispatchQueueConsumerDependencies,
): Promise<NotificationDispatchQueueConsumeResult> {
  const message = parseNotificationDeliveryDispatchQueueMessage(queueMessage.body);
  const observedAt = dependencies.now();
  const plan = await readDispatchPlan(message.deliveryId, observedAt, dependencies);
  const settled = settleDecisionWithoutProvider(queueMessage, plan.decision, observedAt);
  if (settled !== null) return settled;

  if (plan.decision.kind !== "READY") {
    throw new NotificationDispatchQueueRuntimeError("INVALID_RETRY_STATE");
  }

  const coordinated = await coordinateNotificationDeliveryDispatch(
    plan.envelope,
    plan.decision,
    observedAt,
    {
      attemptStore: dependencies.attemptStore,
      claimReader: dependencies.claimStore,
      claimStore: dependencies.claimStore,
      adapter: dependencies.adapter,
    },
  );

  const terminal = settleCoordinatorResult(queueMessage, coordinated);
  if (terminal !== null) return terminal;

  // A recorded retryable provider result is durable evidence. Re-plan from that
  // exact evidence before asking Cloudflare to redeliver; never turn the Queue's
  // own delivery attempt counter into notification resend permission.
  const followUp = await readDispatchPlan(message.deliveryId, observedAt, dependencies);
  const retry = settleDecisionWithoutProvider(queueMessage, followUp.decision, observedAt);
  if (retry !== null) return retry;

  throw new NotificationDispatchQueueRuntimeError("INVALID_RETRY_STATE");
}

export async function consumeNotificationDeliveryDispatchQueueBatch(
  batch: NotificationDispatchQueueBatchLike,
  dependencies: NotificationDispatchQueueConsumerDependencies,
): Promise<readonly NotificationDispatchQueueConsumeResult[]> {
  if (batch.queue !== NOTIFICATION_DISPATCH_QUEUE_NAME) {
    throw new NotificationDispatchQueueRuntimeError("UNEXPECTED_QUEUE");
  }

  const settled = await Promise.allSettled(
    batch.messages.map((message) =>
      consumeNotificationDeliveryDispatchQueueMessage(message, dependencies),
    ),
  );
  const failedCount = settled.reduce(
    (count, result) => count + (result.status === "rejected" ? 1 : 0),
    0,
  );
  if (failedCount > 0) {
    throw new NotificationDispatchQueueRuntimeError("BATCH_FAILED");
  }

  return settled.map((result) => {
    if (result.status !== "fulfilled") {
      throw new NotificationDispatchQueueRuntimeError("BATCH_FAILED");
    }
    return result.value;
  });
}

/** Compose the provider-neutral dispatch runtime with the existing D1 stores. */
export function createCloudflareNotificationDispatchQueueRuntime(
  options: CloudflareNotificationDispatchQueueRuntimeOptions,
): CloudflareNotificationDispatchQueueRuntime {
  const intentStore = new D1NotificationDeliveryIntentStore(options.database);
  const attemptStore = new D1NotificationDeliveryAttemptStore(options.database);
  const claimStore = new D1NotificationDeliveryDispatchClaimStore(options.database);
  const dependencies: NotificationDispatchQueueConsumerDependencies = {
    intentReader: intentStore,
    attemptStore,
    claimStore,
    adapter: options.adapter,
    retryPolicy: options.retryPolicy,
    now: options.now ?? (() => new Date().toISOString()),
  };

  return {
    consumeQueueBatch(batch) {
      return consumeNotificationDeliveryDispatchQueueBatch(batch, dependencies);
    },
  };
}
