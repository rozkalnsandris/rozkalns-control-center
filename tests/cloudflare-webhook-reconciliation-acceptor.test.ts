import assert from "node:assert/strict";
import test from "node:test";

import {
  WebhookReconciliationAcceptor,
  type ReconciliationQueueProducerLike,
} from "../src/integrations/cloudflare/webhook-reconciliation-acceptor.js";
import type {
  DurableClaimedDelivery,
  RecoverableDeliveryClaimStore,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import type { DeliveryClaim } from "../src/shared/github-reconciliation.js";
import type { VerifiedGitHubWebhook } from "../src/shared/github-webhook.js";
import type { ReconciliationQueueMessageV1 } from "../src/shared/reconciliation-queue.js";

const receivedAt = "2026-08-15T11:20:00.000Z";
const enqueuedAt = "2026-08-15T11:20:00.250Z";

const webhook = {
  deliveryId: "delivery-142",
  eventName: "pull_request",
  repository: "rozkalnsandris/hermes-deals",
} as unknown as VerifiedGitHubWebhook;

function durable(overrides: Partial<DurableClaimedDelivery> = {}): DurableClaimedDelivery {
  return {
    deliveryId: "delivery-142",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    eventName: "pull_request",
    messageVersion: 1,
    state: "RECEIVED",
    attemptCount: 0,
    receivedAt,
    enqueuedAt: null,
    processingStartedAt: null,
    lastAttemptAt: null,
    updatedAt: receivedAt,
    completedAt: null,
    deadLetteredAt: null,
    lastErrorCode: null,
    ...overrides,
  };
}

class FakeDeliveryStore implements RecoverableDeliveryClaimStore {
  readonly claims: DeliveryClaim[] = [];
  readonly reads: string[] = [];
  readonly enqueued: Array<{ delivery: DeliveryClaim; enqueuedAt: string }> = [];

  claimResult: "claimed" | "duplicate" = "claimed";
  durableDelivery: DurableClaimedDelivery = durable();
  markError: Error | null = null;

  async claim(delivery: DeliveryClaim): Promise<"claimed" | "duplicate"> {
    this.claims.push(delivery);
    return this.claimResult;
  }

  async readDelivery(deliveryId: string): Promise<DurableClaimedDelivery> {
    this.reads.push(deliveryId);
    return this.durableDelivery;
  }

  async markEnqueued(delivery: DeliveryClaim, changedAt: string): Promise<void> {
    this.enqueued.push({ delivery, enqueuedAt: changedAt });
    if (this.markError) throw this.markError;
  }
}

class FakeQueue implements ReconciliationQueueProducerLike {
  readonly messages: ReconciliationQueueMessageV1[] = [];
  sendError: Error | null = null;

  async send(message: ReconciliationQueueMessageV1): Promise<void> {
    this.messages.push(message);
    if (this.sendError) throw this.sendError;
  }
}

function harness() {
  const deliveryStore = new FakeDeliveryStore();
  const queue = new FakeQueue();
  const acceptor = new WebhookReconciliationAcceptor({
    deliveryStore,
    queue,
    now: () => enqueuedAt,
  });
  return { acceptor, deliveryStore, queue };
}

test("first verified delivery is claimed, synchronously enqueued and marked ENQUEUED", async () => {
  const { acceptor, deliveryStore, queue } = harness();

  assert.equal(await acceptor.accept(webhook, receivedAt), "ACCEPTED");
  assert.deepEqual(deliveryStore.claims, [
    {
      deliveryId: "delivery-142",
      eventName: "pull_request",
      repository: "rozkalnsandris/hermes-deals",
      claimedAt: receivedAt,
    },
  ]);
  assert.deepEqual(deliveryStore.reads, []);
  assert.deepEqual(queue.messages, [
    {
      schemaVersion: 1,
      kind: "GITHUB_RECONCILIATION",
      deliveryId: "delivery-142",
      eventName: "pull_request",
      repository: "rozkalnsandris/hermes-deals",
      projectId: "hermes-deals",
      receivedAt,
      authoritativeReadRequired: true,
    },
  ]);
  assert.deepEqual(deliveryStore.enqueued, [
    {
      delivery: {
        deliveryId: "delivery-142",
        eventName: "pull_request",
        repository: "rozkalnsandris/hermes-deals",
        claimedAt: receivedAt,
      },
      enqueuedAt,
    },
  ]);
});

test("Queue send failure leaves the claimed delivery recoverable and does not mark it ENQUEUED", async () => {
  const { acceptor, deliveryStore, queue } = harness();
  queue.sendError = new Error("queue unavailable");

  await assert.rejects(() => acceptor.accept(webhook, receivedAt), /queue unavailable/);
  assert.equal(queue.messages.length, 1);
  assert.equal(deliveryStore.enqueued.length, 0);
});

test("duplicate still in RECEIVED retries Queue enqueue and then marks ENQUEUED", async () => {
  const { acceptor, deliveryStore, queue } = harness();
  deliveryStore.claimResult = "duplicate";
  deliveryStore.durableDelivery = durable({ state: "RECEIVED" });

  assert.equal(await acceptor.accept(webhook, receivedAt), "ACCEPTED");
  assert.deepEqual(deliveryStore.reads, ["delivery-142"]);
  assert.equal(queue.messages.length, 1);
  assert.equal(deliveryStore.enqueued.length, 1);
});

test("duplicate already ENQUEUED or later does not send another Queue message", async () => {
  for (const state of ["ENQUEUED", "PROCESSING", "RETRY_PENDING", "SUCCEEDED", "DEAD_LETTERED"] as const) {
    const { acceptor, deliveryStore, queue } = harness();
    deliveryStore.claimResult = "duplicate";
    deliveryStore.durableDelivery = durable({ state });

    assert.equal(await acceptor.accept(webhook, receivedAt), "DUPLICATE");
    assert.equal(queue.messages.length, 0);
    assert.equal(deliveryStore.enqueued.length, 0);
  }
});

test("duplicate persisted identity mismatch fails closed before Queue send", async () => {
  const { acceptor, deliveryStore, queue } = harness();
  deliveryStore.claimResult = "duplicate";
  deliveryStore.durableDelivery = durable({ eventName: "push" });

  await assert.rejects(
    () => acceptor.accept(webhook, receivedAt),
    /does not match authenticated delivery identity/,
  );
  assert.equal(queue.messages.length, 0);
  assert.equal(deliveryStore.enqueued.length, 0);
});

test("successful Queue send followed by a raced D1 transition fails closed as at-least-once state", async () => {
  const { acceptor, deliveryStore, queue } = harness();
  deliveryStore.markError = new Error("conditional RECEIVED transition failed");

  await assert.rejects(
    () => acceptor.accept(webhook, receivedAt),
    /conditional RECEIVED transition failed/,
  );
  assert.equal(queue.messages.length, 1);
  assert.equal(deliveryStore.enqueued.length, 1);
});

test("unmanaged authenticated repository fails before durable claim or Queue send", async () => {
  const { acceptor, deliveryStore, queue } = harness();
  const unmanaged = {
    deliveryId: "delivery-142",
    eventName: "pull_request",
    repository: "someone/unknown",
  } as unknown as VerifiedGitHubWebhook;

  await assert.rejects(() => acceptor.accept(unmanaged, receivedAt));
  assert.equal(deliveryStore.claims.length, 0);
  assert.equal(queue.messages.length, 0);
});
