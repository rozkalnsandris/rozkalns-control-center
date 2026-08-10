import type { VerifiedGitHubWebhook } from "./github-webhook.js";
import { requireManagedProjectPolicy } from "./project-policy.js";

export interface DeliveryClaim {
  deliveryId: string;
  eventName: string;
  repository: string;
  claimedAt: string;
}

export interface DeliveryClaimStore {
  claim(delivery: DeliveryClaim): Promise<"claimed" | "duplicate">;
}

export class DuplicateDeliveryError extends Error {
  constructor(deliveryId: string) {
    super(`GitHub webhook delivery was already claimed: ${deliveryId}`);
    this.name = "DuplicateDeliveryError";
  }
}

export interface GitHubReconciliationTrigger {
  deliveryId: string;
  eventName: string;
  repository: string;
  projectId: string;
  receivedAt: string;
  authoritativeReadRequired: true;
}

export class InMemoryDeliveryClaimStore implements DeliveryClaimStore {
  readonly #claimed = new Set<string>();

  async claim(delivery: DeliveryClaim): Promise<"claimed" | "duplicate"> {
    if (this.#claimed.has(delivery.deliveryId)) return "duplicate";
    this.#claimed.add(delivery.deliveryId);
    return "claimed";
  }
}

export async function createGitHubReconciliationTrigger(
  webhook: VerifiedGitHubWebhook,
  receivedAt: string,
  deliveryStore: DeliveryClaimStore,
): Promise<GitHubReconciliationTrigger> {
  const project = requireManagedProjectPolicy(webhook.repository);

  const claim = await deliveryStore.claim({
    deliveryId: webhook.deliveryId,
    eventName: webhook.eventName,
    repository: project.repository,
    claimedAt: receivedAt,
  });

  if (claim === "duplicate") throw new DuplicateDeliveryError(webhook.deliveryId);

  return {
    deliveryId: webhook.deliveryId,
    eventName: webhook.eventName,
    repository: project.repository,
    projectId: project.id,
    receivedAt,
    authoritativeReadRequired: true,
  };
}
