import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { ControlDashboardData, DecisionReadModel } from "../src/shared/control-model.js";
import { NotificationDeliveryContractError } from "../src/shared/notification-delivery.js";
import {
  NotificationDeliveryIntentMaterializationError,
} from "../src/shared/notification-delivery-intent-materialization.js";
import type {
  NotificationDeliveryIntent,
  NotificationDeliveryIntentEnqueueResult,
  NotificationDeliveryIntentStore,
} from "../src/shared/notification-delivery-intent-store.js";
import {
  NotificationTransitionDeliveryReconciliationError,
  reconcileNotificationTransitionDeliveries,
} from "../src/shared/notification-transition-delivery-reconciliation.js";
import type {
  NotificationTransitionClaim,
  NotificationTransitionClaimResult,
  NotificationTransitionStore,
} from "../src/shared/notification-transition-store.js";

const NOW = "2026-08-20T18:45:00.000Z";

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
    prTitle: `Pull request ${id}`,
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

class FakeTransitionStore implements NotificationTransitionStore {
  readonly claims: NotificationTransitionClaim[] = [];
  readonly seen = new Set<string>();
  malformedResult = false;

  async claim(input: NotificationTransitionClaim): Promise<NotificationTransitionClaimResult> {
    this.claims.push(input);
    if (this.malformedResult) {
      return { kind: "UNKNOWN" } as unknown as NotificationTransitionClaimResult;
    }
    if (this.seen.has(input.candidate.transitionId)) return { kind: "DUPLICATE" };
    this.seen.add(input.candidate.transitionId);
    return { kind: "CLAIMED" };
  }
}

class FakeIntentStore implements NotificationDeliveryIntentStore {
  readonly calls: NotificationDeliveryIntent[] = [];
  readonly durable = new Map<string, NotificationDeliveryIntent>();
  failTargetOnce: string | null = null;
  #failed = false;

  async enqueue(
    intent: NotificationDeliveryIntent,
  ): Promise<NotificationDeliveryIntentEnqueueResult> {
    this.calls.push(intent);
    if (
      this.failTargetOnce === intent.envelope.targetKey &&
      !this.#failed
    ) {
      this.#failed = true;
      throw new Error("fake intent store failure");
    }
    if (this.durable.has(intent.envelope.deliveryId)) return { kind: "DUPLICATE" };
    this.durable.set(intent.envelope.deliveryId, intent);
    return { kind: "ENQUEUED" };
  }
}

function input(
  decisions: readonly DecisionReadModel[],
  targetKeys: readonly string[] = ["primary"],
  observedAt = NOW,
) {
  return {
    snapshot: dashboard(decisions),
    observedAt,
    targetKeys,
  };
}

test("CLAIMED transitions materialize explicit targets in deterministic decision and target order", async () => {
  const transitions = new FakeTransitionStore();
  const intents = new FakeIntentStore();

  const result = await reconcileNotificationTransitionDeliveries(
    input(
      [
        decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision required"),
        decision("waiting", "WAITING", "WAITING", "Still waiting"),
        decision("failed", "CI_FAILED", "FAIL", "CI failed and needs inspection"),
      ],
      ["primary", "backup"],
    ),
    transitions,
    intents,
  );

  assert.deepEqual(result, {
    transitions: { claimed: 2, duplicates: 0, ignored: 1 },
    intents: { enqueued: 4, duplicates: 0 },
  });
  assert.deepEqual(
    transitions.claims.map((claim) => claim.candidate.decisionId),
    ["needs", "failed"],
  );
  assert.ok(transitions.claims.every((claim) => claim.claimedAt === NOW));
  assert.deepEqual(
    intents.calls.map((intent) => [intent.envelope.decisionId, intent.envelope.targetKey]),
    [
      ["needs", "primary"],
      ["needs", "backup"],
      ["failed", "primary"],
      ["failed", "backup"],
    ],
  );
  assert.ok(intents.calls.every((intent) => intent.queuedAt === NOW));
});

test("DUPLICATE transition evidence still materializes missing delivery intents", async () => {
  const transitions = new FakeTransitionStore();
  const intents = new FakeIntentStore();
  const snapshot = input([
    decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision required"),
  ]);

  assert.deepEqual(
    await reconcileNotificationTransitionDeliveries(snapshot, transitions, intents),
    {
      transitions: { claimed: 1, duplicates: 0, ignored: 0 },
      intents: { enqueued: 1, duplicates: 0 },
    },
  );

  intents.durable.clear();
  intents.calls.length = 0;

  assert.deepEqual(
    await reconcileNotificationTransitionDeliveries(snapshot, transitions, intents),
    {
      transitions: { claimed: 0, duplicates: 1, ignored: 0 },
      intents: { enqueued: 1, duplicates: 0 },
    },
  );
  assert.equal(intents.calls.length, 1);
});

test("partial intent failure is restart-safe: retry replays duplicate transition and already durable intent", async () => {
  const transitions = new FakeTransitionStore();
  const intents = new FakeIntentStore();
  intents.failTargetOnce = "backup";
  const snapshot = input(
    [decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision required")],
    ["primary", "backup"],
  );

  await assert.rejects(
    () => reconcileNotificationTransitionDeliveries(snapshot, transitions, intents),
    /fake intent store failure/,
  );
  assert.equal(transitions.seen.size, 1);
  assert.equal(intents.durable.size, 1);
  assert.equal(intents.calls[0]?.envelope.targetKey, "primary");
  assert.equal(intents.calls[1]?.envelope.targetKey, "backup");

  intents.calls.length = 0;
  assert.deepEqual(
    await reconcileNotificationTransitionDeliveries(snapshot, transitions, intents),
    {
      transitions: { claimed: 0, duplicates: 1, ignored: 0 },
      intents: { enqueued: 1, duplicates: 1 },
    },
  );
  assert.deepEqual(
    intents.calls.map((intent) => intent.envelope.targetKey),
    ["primary", "backup"],
  );
  assert.equal(intents.durable.size, 2);
});

test("complete high-signal batch is prevalidated before the first durable call", async () => {
  const decisions = [
    decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision required"),
    decision("failed", "CI_FAILED", "FAIL", "CI failed and needs inspection"),
  ];

  for (const badInput of [
    input(decisions, ["primary", "Bad target"]),
    input(decisions, ["primary", "primary"]),
    input(decisions, ["primary"], "2026-08-20T20:45:00+02:00"),
  ]) {
    const transitions = new FakeTransitionStore();
    const intents = new FakeIntentStore();

    await assert.rejects(
      () => reconcileNotificationTransitionDeliveries(badInput, transitions, intents),
      (error: unknown) =>
        error instanceof NotificationDeliveryContractError ||
        error instanceof NotificationDeliveryIntentMaterializationError,
    );
    assert.deepEqual(transitions.claims, []);
    assert.deepEqual(intents.calls, []);
  }
});

test("malformed transition-store result fails closed before intent enqueue", async () => {
  const transitions = new FakeTransitionStore();
  transitions.malformedResult = true;
  const intents = new FakeIntentStore();

  await assert.rejects(
    () =>
      reconcileNotificationTransitionDeliveries(
        input([decision("needs", "NEEDS_ANDRIS", "PASS", "Owner decision required")]),
        transitions,
        intents,
      ),
    (error: unknown) =>
      error instanceof NotificationTransitionDeliveryReconciliationError &&
      error.code === "INVALID_TRANSITION_STORE_RESULT",
  );
  assert.equal(transitions.claims.length, 1);
  assert.deepEqual(intents.calls, []);
});

test("low-signal decisions remain ignored without transition or intent mutation", async () => {
  const transitions = new FakeTransitionStore();
  const intents = new FakeIntentStore();

  assert.deepEqual(
    await reconcileNotificationTransitionDeliveries(
      input([decision("waiting", "WAITING", "WAITING", "Still waiting")]),
      transitions,
      intents,
    ),
    {
      transitions: { claimed: 0, duplicates: 0, ignored: 1 },
      intents: { enqueued: 0, duplicates: 0 },
    },
  );
  assert.deepEqual(transitions.claims, []);
  assert.deepEqual(intents.calls, []);
});

test("restart-safe transition-to-intent reconciliation is confined to dormant Cloudflare Queue runtime wiring", () => {
  const worker = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const batchRuntime = readFileSync(
    resolve(process.cwd(), "src/integrations/cloudflare/cloudflare-reconciliation-batch-runtime.ts"),
    "utf8",
  );
  const queueRuntime = readFileSync(
    resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
    "utf8",
  );
  const reactApp = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
  const runtimePattern =
    /notification-transition-delivery-reconciliation|reconcileNotificationTransitionDeliveries/;

  assert.match(batchRuntime, runtimePattern);
  assert.match(queueRuntime, /notificationDelivery/);
  assert.doesNotMatch(worker, runtimePattern);
  assert.doesNotMatch(reactApp, runtimePattern);
});
