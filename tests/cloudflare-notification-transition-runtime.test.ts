import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareReconciliationBatchHandler } from "../src/integrations/cloudflare/cloudflare-reconciliation-batch-runtime.js";
import type {
  DeliveryLifecycleStore,
  DurableClaimedDelivery,
  DurableDeliveryIdentity,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import type { QueueMessageControlLike } from "../src/integrations/cloudflare/reconciliation-queue-consumer.js";
import type { CloudflareGitHubRuntimeBindings } from "../src/integrations/github/cloudflare-worker-runtime.js";
import type { ControlDashboardData, DecisionReadModel } from "../src/shared/control-model.js";
import type {
  NotificationTransitionClaim,
  NotificationTransitionClaimResult,
  NotificationTransitionStore,
} from "../src/shared/notification-transition-store.js";
import type { ReconciliationQueueMessageV1 } from "../src/shared/reconciliation-queue.js";

const NOW = "2026-08-19T19:45:00.000Z";
const QUEUE = "rozkalns-control-reconciliation";
const GITHUB_BINDINGS: CloudflareGitHubRuntimeBindings = {
  GITHUB_APP_PRIVATE_KEY_PEM: "test-private-key",
  GITHUB_APP_CLIENT_ID: "test-client-id",
  GITHUB_APP_INSTALLATION_ID: "123",
};

function decision(
  id: string,
  workflowState: DecisionReadModel["workflowState"],
  ci: DecisionReadModel["ci"],
  reason: string,
): DecisionReadModel {
  return {
    id,
    projectId: "hermes-deals",
    workflowState,
    issueNumber: 10,
    issueTitle: "Issue title",
    prNumber: 20,
    prTitle: "Pull request title",
    prUrl: "https://github.com/rozkalnsandris/hermes-deals/pull/20",
    ci,
    review: "PENDING",
    deployImpact: "UNKNOWN",
    changedFiles: 2,
    expectedHeadSha: "1111111111111111111111111111111111111111",
    currentHeadSha: "1111111111111111111111111111111111111111",
    mainSha: "2222222222222222222222222222222222222222",
    reason,
    lastReconciledAt: NOW,
    allowedActions: ["OPEN_PR"],
  };
}

function dashboard(decisions: readonly DecisionReadModel[]): ControlDashboardData {
  return {
    generatedAt: NOW,
    projects: [],
    decisions: [...decisions],
  };
}

function queueBody(deliveryId: string): ReconciliationQueueMessageV1 {
  return {
    schemaVersion: 1,
    kind: "GITHUB_RECONCILIATION",
    deliveryId,
    eventName: "pull_request",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    receivedAt: "2026-08-19T19:44:00.000Z",
    authoritativeReadRequired: true,
  };
}

class FakeQueueMessage implements QueueMessageControlLike {
  readonly controls: string[] = [];

  constructor(readonly body: unknown) {}

  ack(): void {
    this.controls.push("ack");
  }

  retry(): void {
    this.controls.push("retry");
  }
}

class FakeLifecycleStore implements DeliveryLifecycleStore {
  readonly deliveries = new Map<string, DurableClaimedDelivery>();

  add(deliveryId: string): void {
    this.deliveries.set(deliveryId, {
      deliveryId,
      repository: "rozkalnsandris/hermes-deals",
      projectId: "hermes-deals",
      eventName: "pull_request",
      messageVersion: 1,
      state: "ENQUEUED",
      attemptCount: 0,
      receivedAt: "2026-08-19T19:44:00.000Z",
      enqueuedAt: "2026-08-19T19:44:01.000Z",
      processingStartedAt: null,
      lastAttemptAt: null,
      updatedAt: "2026-08-19T19:44:01.000Z",
      completedAt: null,
      deadLetteredAt: null,
      lastErrorCode: null,
    });
  }

  async readDelivery(deliveryId: string): Promise<DurableClaimedDelivery> {
    return this.require(deliveryId);
  }

  async markProcessing(delivery: DurableDeliveryIdentity, processingAt: string): Promise<void> {
    this.replace(delivery.deliveryId, {
      state: "PROCESSING",
      attemptCount: this.require(delivery.deliveryId).attemptCount + 1,
      processingStartedAt: processingAt,
      lastAttemptAt: processingAt,
      updatedAt: processingAt,
    });
  }

  async markRetryPending(
    delivery: DurableDeliveryIdentity,
    changedAt: string,
    errorCode: string,
  ): Promise<void> {
    this.replace(delivery.deliveryId, {
      state: "RETRY_PENDING",
      updatedAt: changedAt,
      lastErrorCode: errorCode,
    });
  }

  async markSucceeded(delivery: DurableDeliveryIdentity, completedAt: string): Promise<void> {
    this.replace(delivery.deliveryId, {
      state: "SUCCEEDED",
      updatedAt: completedAt,
      completedAt,
      lastErrorCode: null,
    });
  }

  async markDeadLettered(
    delivery: DurableDeliveryIdentity,
    changedAt: string,
    errorCode: string,
  ): Promise<void> {
    this.replace(delivery.deliveryId, {
      state: "DEAD_LETTERED",
      updatedAt: changedAt,
      deadLetteredAt: changedAt,
      lastErrorCode: errorCode,
    });
  }

  private require(deliveryId: string): DurableClaimedDelivery {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) throw new Error("missing fake delivery");
    return delivery;
  }

  private replace(deliveryId: string, patch: Partial<DurableClaimedDelivery>): void {
    this.deliveries.set(deliveryId, { ...this.require(deliveryId), ...patch });
  }
}

class FakeTransitionStore implements NotificationTransitionStore {
  readonly claims: NotificationTransitionClaim[] = [];
  readonly seen = new Set<string>();
  claimedCount = 0;
  duplicateCount = 0;
  failDecisionId: string | null = null;

  async claim(input: NotificationTransitionClaim): Promise<NotificationTransitionClaimResult> {
    this.claims.push(input);
    if (input.candidate.decisionId === this.failDecisionId) {
      throw new Error("fake transition store failure");
    }
    if (this.seen.has(input.candidate.transitionId)) {
      this.duplicateCount += 1;
      return { kind: "DUPLICATE" };
    }
    this.seen.add(input.candidate.transitionId);
    this.claimedCount += 1;
    return { kind: "CLAIMED" };
  }
}

function messageBatch(message: FakeQueueMessage) {
  return { queue: QUEUE, messages: [message] };
}

test("optional transition store claims only high-signal decisions after one dashboard read", async () => {
  const lifecycle = new FakeLifecycleStore();
  lifecycle.add("delivery-1");
  const transitions = new FakeTransitionStore();
  let dashboardReads = 0;
  const snapshot = dashboard([
    decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision required"),
    decision("failed", "CI_FAILED", "FAIL", "CI failed and needs inspection"),
    decision("waiting", "WAITING", "WAITING", "Still waiting"),
  ]);
  const handler = createCloudflareReconciliationBatchHandler({
    bindings: GITHUB_BINDINGS,
    deliveryStore: lifecycle,
    expectedQueue: QUEUE,
    now: () => NOW,
    readDashboard: async () => {
      dashboardReads += 1;
      return snapshot;
    },
    notificationTransitionStore: transitions,
  });
  const message = new FakeQueueMessage(queueBody("delivery-1"));

  assert.deepEqual(await handler(messageBatch(message)), ["ACKED"]);
  assert.equal(dashboardReads, 1);
  assert.deepEqual(message.controls, ["ack"]);
  assert.equal(lifecycle.deliveries.get("delivery-1")?.state, "SUCCEEDED");
  assert.deepEqual(
    transitions.claims.map((claim) => claim.candidate.decisionId),
    ["needs", "failed"],
  );
  assert.ok(transitions.claims.every((claim) => claim.claimedAt === NOW));
  assert.ok(
    transitions.claims.every((claim) => claim.candidate.deepLinkPath.startsWith("/#decision-")),
  );
});

test("unchanged snapshots become durable duplicates while changed evidence creates a new transition", async () => {
  const lifecycle = new FakeLifecycleStore();
  const transitions = new FakeTransitionStore();
  let current = dashboard([
    decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision required"),
    decision("failed", "CI_FAILED", "FAIL", "CI failed and needs inspection"),
  ]);
  let dashboardReads = 0;
  const handler = createCloudflareReconciliationBatchHandler({
    bindings: GITHUB_BINDINGS,
    deliveryStore: lifecycle,
    expectedQueue: QUEUE,
    now: () => NOW,
    readDashboard: async () => {
      dashboardReads += 1;
      return current;
    },
    notificationTransitionStore: transitions,
  });

  for (const deliveryId of ["delivery-a", "delivery-b"]) {
    lifecycle.add(deliveryId);
    const message = new FakeQueueMessage(queueBody(deliveryId));
    assert.deepEqual(await handler(messageBatch(message)), ["ACKED"]);
  }

  assert.equal(transitions.claimedCount, 2);
  assert.equal(transitions.duplicateCount, 2);
  assert.equal(transitions.seen.size, 2);

  current = dashboard([
    decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision changed materially"),
    decision("failed", "CI_FAILED", "FAIL", "CI failed and needs inspection"),
  ]);
  lifecycle.add("delivery-c");
  const changedMessage = new FakeQueueMessage(queueBody("delivery-c"));
  assert.deepEqual(await handler(messageBatch(changedMessage)), ["ACKED"]);

  assert.equal(dashboardReads, 3);
  assert.equal(transitions.claimedCount, 3);
  assert.equal(transitions.duplicateCount, 3);
  assert.equal(transitions.seen.size, 3);
});

test("transition-store failure keeps Queue delivery retryable and does not report success", async () => {
  const lifecycle = new FakeLifecycleStore();
  lifecycle.add("delivery-fail");
  const transitions = new FakeTransitionStore();
  transitions.failDecisionId = "needs";
  let dashboardReads = 0;
  const handler = createCloudflareReconciliationBatchHandler({
    bindings: GITHUB_BINDINGS,
    deliveryStore: lifecycle,
    expectedQueue: QUEUE,
    now: () => NOW,
    readDashboard: async () => {
      dashboardReads += 1;
      return dashboard([decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision required")]);
    },
    notificationTransitionStore: transitions,
  });
  const message = new FakeQueueMessage(queueBody("delivery-fail"));

  assert.deepEqual(await handler(messageBatch(message)), ["RETRY_REQUESTED"]);
  assert.equal(dashboardReads, 1);
  assert.deepEqual(message.controls, ["retry"]);
  assert.equal(lifecycle.deliveries.get("delivery-fail")?.state, "RETRY_PENDING");
  assert.equal(
    lifecycle.deliveries.get("delivery-fail")?.lastErrorCode,
    "AUTHORITATIVE_RECONCILIATION_FAILED",
  );
});

test("omitting the optional transition store preserves the existing reconciliation-only path", async () => {
  const lifecycle = new FakeLifecycleStore();
  lifecycle.add("delivery-dormant");
  let dashboardReads = 0;
  const handler = createCloudflareReconciliationBatchHandler({
    bindings: GITHUB_BINDINGS,
    deliveryStore: lifecycle,
    expectedQueue: QUEUE,
    now: () => NOW,
    readDashboard: async () => {
      dashboardReads += 1;
      return dashboard([decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision required")]);
    },
  });
  const message = new FakeQueueMessage(queueBody("delivery-dormant"));

  assert.deepEqual(await handler(messageBatch(message)), ["ACKED"]);
  assert.equal(dashboardReads, 1);
  assert.deepEqual(message.controls, ["ack"]);
  assert.equal(lifecycle.deliveries.get("delivery-dormant")?.state, "SUCCEEDED");
});
