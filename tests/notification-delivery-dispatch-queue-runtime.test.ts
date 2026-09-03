import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeNotificationDeliveryDispatchQueueBatch,
  NOTIFICATION_DISPATCH_QUEUE_NAME,
  type NotificationDispatchQueueMessageControlLike,
} from "../src/integrations/cloudflare/cloudflare-notification-dispatch-queue-runtime.js";
import {
  appendNotificationDeliveryAttempt,
  notificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptRecord,
} from "../src/shared/notification-delivery-attempt.js";
import type {
  NotificationDeliveryAttemptAppendResult,
  NotificationDeliveryAttemptStore,
} from "../src/shared/notification-delivery-attempt-store.js";
import {
  notificationDeliveryDispatchId,
  type NotificationDeliveryDispatchAdapter,
  type NotificationDeliveryDispatchAttempt,
} from "../src/shared/notification-delivery-dispatch-attempt.js";
import type {
  NotificationDeliveryDispatchClaimRecoveryEvidence,
  NotificationDeliveryDispatchClaimRecoveryReader,
  NotificationDeliveryDispatchClaimResult,
  NotificationDeliveryDispatchClaimSnapshot,
  NotificationDeliveryDispatchClaimStore,
} from "../src/shared/notification-delivery-dispatch-claim-store.js";
import {
  createNotificationDeliveryDispatchQueueMessage,
  parseNotificationDeliveryDispatchQueueMessage,
} from "../src/shared/notification-delivery-dispatch-queue.js";
import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
  type NotificationDeliveryResult,
} from "../src/shared/notification-delivery.js";
import type {
  NotificationDeliveryIntentRecoveryEvidence,
  NotificationDeliveryIntentRecoveryReader,
} from "../src/shared/notification-delivery-intent-store.js";

const QUEUED_AT = "2026-09-03T12:00:00.000Z";

function deliveryEnvelope(): NotificationDeliveryEnvelope {
  return notificationDeliveryEnvelope(
    {
      schemaVersion: 1,
      signal: "NEEDS_ANDRIS",
      transitionId: "notification-v1-needs-andris-0123456789abcdef",
      decisionId: "decision-runtime-test",
      projectId: "hermes-deals",
      reference: "PR #20",
      title: "Runtime notification",
      body: "Owner decision required",
      deepLinkPath: "/#decision-decision-runtime-test",
    },
    "primary",
  );
}

class FakeIntentReader implements NotificationDeliveryIntentRecoveryReader {
  constructor(readonly envelope: NotificationDeliveryEnvelope) {}

  async read(deliveryId: string): Promise<NotificationDeliveryIntentRecoveryEvidence> {
    if (deliveryId !== this.envelope.deliveryId) return { kind: "NOT_FOUND" };
    return {
      kind: "FOUND",
      intent: {
        envelope: this.envelope,
        queuedAt: QUEUED_AT,
      },
    };
  }
}

class FakeAttemptStore implements NotificationDeliveryAttemptStore {
  history: NotificationDeliveryAttemptHistory;

  constructor(readonly deliveryId: string) {
    this.history = notificationDeliveryAttemptHistory(deliveryId);
  }

  async readHistory(deliveryId: string): Promise<NotificationDeliveryAttemptHistory> {
    assert.equal(deliveryId, this.deliveryId);
    return this.history;
  }

  async append(
    attempt: NotificationDeliveryAttemptRecord,
  ): Promise<NotificationDeliveryAttemptAppendResult> {
    const existing = this.history.attempts[attempt.attemptNumber - 1];
    if (existing) {
      assert.deepEqual(existing, attempt);
      return { kind: "DUPLICATE" };
    }
    this.history = appendNotificationDeliveryAttempt(this.history, attempt);
    return { kind: "APPENDED" };
  }
}

class FakeClaimStore
  implements NotificationDeliveryDispatchClaimStore, NotificationDeliveryDispatchClaimRecoveryReader
{
  readonly claims = new Map<string, NotificationDeliveryDispatchClaimSnapshot>();

  snapshotFor(attempt: NotificationDeliveryDispatchAttempt): NotificationDeliveryDispatchClaimSnapshot {
    return {
      schemaVersion: 1,
      dispatchId: attempt.dispatchId,
      deliveryId: attempt.deliveryId,
      attemptNumber: attempt.attemptNumber,
      transitionId: attempt.envelope.transitionId,
      targetKey: attempt.envelope.targetKey,
      attemptedAt: attempt.attemptedAt,
    };
  }

  preclaim(
    envelope: NotificationDeliveryEnvelope,
    attemptNumber: number,
    attemptedAt: string,
  ): void {
    const dispatchId = notificationDeliveryDispatchId(envelope.deliveryId, attemptNumber);
    this.claims.set(dispatchId, {
      schemaVersion: 1,
      dispatchId,
      deliveryId: envelope.deliveryId,
      attemptNumber,
      transitionId: envelope.transitionId,
      targetKey: envelope.targetKey,
      attemptedAt,
    });
  }

  async claim(
    attempt: NotificationDeliveryDispatchAttempt,
  ): Promise<NotificationDeliveryDispatchClaimResult> {
    if (this.claims.has(attempt.dispatchId)) return { kind: "ALREADY_CLAIMED" };
    this.claims.set(attempt.dispatchId, this.snapshotFor(attempt));
    return { kind: "CLAIMED" };
  }

  async readSnapshot(
    deliveryId: string,
    attemptNumber: number,
  ): Promise<NotificationDeliveryDispatchClaimRecoveryEvidence> {
    const dispatchId = notificationDeliveryDispatchId(deliveryId, attemptNumber);
    const claim = this.claims.get(dispatchId);
    return claim ? { kind: "CLAIMED", claim } : { kind: "NOT_CLAIMED" };
  }
}

class FakeAdapter implements NotificationDeliveryDispatchAdapter {
  readonly calls: NotificationDeliveryDispatchAttempt[] = [];

  constructor(readonly results: readonly NotificationDeliveryResult[]) {}

  async deliver(attempt: NotificationDeliveryDispatchAttempt): Promise<NotificationDeliveryResult> {
    this.calls.push(attempt);
    const result = this.results[this.calls.length - 1];
    if (!result) throw new Error("unexpected fake provider call");
    return result;
  }
}

class FakeQueueMessage implements NotificationDispatchQueueMessageControlLike {
  readonly controls: Array<
    | { readonly kind: "ACK" }
    | { readonly kind: "RETRY"; readonly delaySeconds: number | undefined }
  > = [];

  constructor(readonly body: unknown) {}

  ack(): void {
    this.controls.push({ kind: "ACK" });
  }

  retry(options?: { readonly delaySeconds?: number }): void {
    this.controls.push({ kind: "RETRY", delaySeconds: options?.delaySeconds });
  }
}

function dependencies(
  envelope: NotificationDeliveryEnvelope,
  attempts: FakeAttemptStore,
  claims: FakeClaimStore,
  adapter: FakeAdapter,
  now: () => string,
  retryPolicy = { schemaVersion: 1 as const, maxAttempts: 2, retryDelaysSeconds: [60] },
) {
  return {
    intentReader: new FakeIntentReader(envelope),
    attemptStore: attempts,
    claimStore: claims,
    adapter,
    retryPolicy,
    now,
  };
}

test("dispatch Queue message carries only deterministic delivery identity", () => {
  const envelope = deliveryEnvelope();
  const message = createNotificationDeliveryDispatchQueueMessage(envelope.deliveryId);
  assert.deepEqual(parseNotificationDeliveryDispatchQueueMessage(message), message);
  assert.deepEqual(Object.keys(message), ["schemaVersion", "kind", "deliveryId"]);

  assert.throws(() =>
    parseNotificationDeliveryDispatchQueueMessage({
      ...message,
      destination: "must-not-be-here",
    }),
  );
  assert.throws(() =>
    parseNotificationDeliveryDispatchQueueMessage({
      schemaVersion: 1,
      kind: "NOTIFICATION_DELIVERY_DISPATCH",
      deliveryId: "bad",
    }),
  );
});

test("READY delivery crosses the adapter once, records result and acknowledges", async () => {
  const envelope = deliveryEnvelope();
  const attempts = new FakeAttemptStore(envelope.deliveryId);
  const claims = new FakeClaimStore();
  const adapter = new FakeAdapter([{ kind: "DELIVERED" }]);
  const message = new FakeQueueMessage(
    createNotificationDeliveryDispatchQueueMessage(envelope.deliveryId),
  );

  assert.deepEqual(
    await consumeNotificationDeliveryDispatchQueueBatch(
      { queue: NOTIFICATION_DISPATCH_QUEUE_NAME, messages: [message] },
      dependencies(
        envelope,
        attempts,
        claims,
        adapter,
        () => QUEUED_AT,
        { schemaVersion: 1, maxAttempts: 1, retryDelaysSeconds: [] },
      ),
    ),
    ["ACKED"],
  );
  assert.deepEqual(message.controls, [{ kind: "ACK" }]);
  assert.equal(adapter.calls.length, 1);
  assert.equal(attempts.history.status, "DELIVERED");
});

test("retryable provider evidence uses explicit delayed Queue retry and does not resend before eligibility", async () => {
  const envelope = deliveryEnvelope();
  const attempts = new FakeAttemptStore(envelope.deliveryId);
  const claims = new FakeClaimStore();
  const adapter = new FakeAdapter([
    { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" },
    { kind: "DELIVERED" },
  ]);
  let now = QUEUED_AT;
  const deps = dependencies(envelope, attempts, claims, adapter, () => now);

  const first = new FakeQueueMessage(
    createNotificationDeliveryDispatchQueueMessage(envelope.deliveryId),
  );
  assert.deepEqual(
    await consumeNotificationDeliveryDispatchQueueBatch(
      { queue: NOTIFICATION_DISPATCH_QUEUE_NAME, messages: [first] },
      deps,
    ),
    ["RETRY_REQUESTED"],
  );
  assert.deepEqual(first.controls, [{ kind: "RETRY", delaySeconds: 60 }]);
  assert.equal(adapter.calls.length, 1);

  now = "2026-09-03T12:00:30.000Z";
  const earlyReplay = new FakeQueueMessage(
    createNotificationDeliveryDispatchQueueMessage(envelope.deliveryId),
  );
  assert.deepEqual(
    await consumeNotificationDeliveryDispatchQueueBatch(
      { queue: NOTIFICATION_DISPATCH_QUEUE_NAME, messages: [earlyReplay] },
      deps,
    ),
    ["RETRY_REQUESTED"],
  );
  assert.deepEqual(earlyReplay.controls, [{ kind: "RETRY", delaySeconds: 30 }]);
  assert.equal(adapter.calls.length, 1);

  now = "2026-09-03T12:01:00.000Z";
  const eligibleReplay = new FakeQueueMessage(
    createNotificationDeliveryDispatchQueueMessage(envelope.deliveryId),
  );
  assert.deepEqual(
    await consumeNotificationDeliveryDispatchQueueBatch(
      { queue: NOTIFICATION_DISPATCH_QUEUE_NAME, messages: [eligibleReplay] },
      deps,
    ),
    ["ACKED"],
  );
  assert.deepEqual(eligibleReplay.controls, [{ kind: "ACK" }]);
  assert.equal(adapter.calls.length, 2);
  assert.equal(attempts.history.status, "DELIVERED");
});

test("durable ambiguous claim is acknowledged as replay barrier without provider resend", async () => {
  const envelope = deliveryEnvelope();
  const attempts = new FakeAttemptStore(envelope.deliveryId);
  const claims = new FakeClaimStore();
  claims.preclaim(envelope, 1, QUEUED_AT);
  const adapter = new FakeAdapter([{ kind: "DELIVERED" }]);
  const message = new FakeQueueMessage(
    createNotificationDeliveryDispatchQueueMessage(envelope.deliveryId),
  );

  assert.deepEqual(
    await consumeNotificationDeliveryDispatchQueueBatch(
      { queue: NOTIFICATION_DISPATCH_QUEUE_NAME, messages: [message] },
      dependencies(envelope, attempts, claims, adapter, () => QUEUED_AT),
    ),
    ["AMBIGUOUS_ACKED"],
  );
  assert.deepEqual(message.controls, [{ kind: "ACK" }]);
  assert.equal(adapter.calls.length, 0);
  assert.equal(attempts.history.status, "PENDING");
});
