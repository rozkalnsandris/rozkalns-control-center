import type { VerifiedGitHubWebhook } from "../../shared/github-webhook.js";
import type { DeliveryClaim, GitHubReconciliationTrigger } from "../../shared/github-reconciliation.js";
import {
  createReconciliationQueueMessage,
  type ReconciliationQueueMessageV1,
} from "../../shared/reconciliation-queue.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import type {
  DurableClaimedDelivery,
  RecoverableDeliveryClaimStore,
} from "./d1-delivery-claim-store.js";

export interface ReconciliationQueueProducerLike {
  send(message: ReconciliationQueueMessageV1): Promise<void>;
}

export type WebhookAcceptanceResult = "ACCEPTED" | "DUPLICATE";

export interface WebhookReconciliationAcceptorOptions {
  readonly deliveryStore: RecoverableDeliveryClaimStore;
  readonly queue: ReconciliationQueueProducerLike;
  readonly now?: () => string;
}

function requireDuplicateIdentity(
  durable: DurableClaimedDelivery,
  webhook: VerifiedGitHubWebhook,
  projectId: string,
): void {
  if (
    durable.deliveryId !== webhook.deliveryId ||
    durable.repository !== webhook.repository ||
    durable.projectId !== projectId ||
    durable.eventName !== webhook.eventName ||
    durable.messageVersion !== 1
  ) {
    throw new Error("Persisted webhook delivery does not match authenticated delivery identity");
  }
}

function triggerFor(
  webhook: VerifiedGitHubWebhook,
  projectId: string,
  receivedAt: string,
): GitHubReconciliationTrigger {
  return {
    deliveryId: webhook.deliveryId,
    eventName: webhook.eventName,
    repository: webhook.repository,
    projectId,
    receivedAt,
    authoritativeReadRequired: true,
  };
}

export class WebhookReconciliationAcceptor {
  readonly #deliveryStore: RecoverableDeliveryClaimStore;
  readonly #queue: ReconciliationQueueProducerLike;
  readonly #now: () => string;

  constructor(options: WebhookReconciliationAcceptorOptions) {
    this.#deliveryStore = options.deliveryStore;
    this.#queue = options.queue;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async accept(webhook: VerifiedGitHubWebhook, receivedAt: string): Promise<WebhookAcceptanceResult> {
    const project = requireManagedProjectPolicy(webhook.repository);
    const delivery: DeliveryClaim = {
      deliveryId: webhook.deliveryId,
      eventName: webhook.eventName,
      repository: project.repository,
      claimedAt: receivedAt,
    };

    const claim = await this.#deliveryStore.claim(delivery);
    if (claim === "duplicate") {
      const durable = await this.#deliveryStore.readDelivery(webhook.deliveryId);
      requireDuplicateIdentity(durable, webhook, project.id);

      if (durable.state !== "RECEIVED") {
        return "DUPLICATE";
      }
    }

    const message = createReconciliationQueueMessage(triggerFor(webhook, project.id, receivedAt));

    // Await the producer write at the request boundary. If it fails, D1 remains
    // RECEIVED so a later authenticated GitHub retry can recover the delivery.
    await this.#queue.send(message);

    // This is intentionally conditional on RECEIVED. A Queue send followed by
    // a failed/raced D1 transition is an observable at-least-once condition;
    // downstream processing must remain idempotent by delivery id.
    await this.#deliveryStore.markEnqueued(delivery, this.#now());

    return "ACCEPTED";
  }
}
