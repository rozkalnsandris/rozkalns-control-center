import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

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
  coordinateNotificationDeliveryDispatch,
  NotificationDeliveryDispatchCoordinatorError,
} from "../src/shared/notification-delivery-dispatch-coordinator.js";
import type { NotificationDeliveryDispatchDecision } from "../src/shared/notification-delivery-dispatch-decision.js";
import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryResult,
} from "../src/shared/notification-delivery.js";
import type { NotificationCandidate } from "../src/shared/notification-transition.js";

const candidate: NotificationCandidate = {
  schemaVersion: 1,
  signal: "NEEDS_ANDRIS",
  transitionId: "notification-v1-needs-andris-0123456789abcdef",
  decisionId: "github:hermes-deals:pr:517",
  projectId: "hermes-deals",
  reference: "PR #517",
  title: "Owner decision required",
  body: "Review the exact decision before continuing",
  deepLinkPath: "/#decision-6769746875623a6865726d65732d6465616c733a70723a353137",
};

const envelope = notificationDeliveryEnvelope(candidate, "primary");
const readyDecision: NotificationDeliveryDispatchDecision = {
  kind: "READY",
  attemptNumber: 1,
  eligibleAt: "2026-08-20T09:00:00.000Z",
};
const attemptedAt = "2026-08-20T09:05:00.000Z";

function record(
  attemptedAtValue: string,
  result: NotificationDeliveryResult,
): NotificationDeliveryAttemptRecord {
  return {
    schemaVersion: 1,
    deliveryId: envelope.deliveryId,
    attemptNumber: 1,
    attemptedAt: attemptedAtValue,
    result,
  };
}

function historyWith(recorded?: NotificationDeliveryAttemptRecord): NotificationDeliveryAttemptHistory {
  const history = notificationDeliveryAttemptHistory(envelope.deliveryId);
  return recorded ? appendNotificationDeliveryAttempt(history, recorded) : history;
}

class FakeAttemptStore implements NotificationDeliveryAttemptStore {
  history: NotificationDeliveryAttemptHistory;
  readCalls = 0;
  appendCalls = 0;
  appendMode: "APPENDED" | "THROW_BEFORE" | "THROW_AFTER" = "APPENDED";

  constructor(history = historyWith()) {
    this.history = history;
  }

  async readHistory(deliveryId: string): Promise<NotificationDeliveryAttemptHistory> {
    this.readCalls += 1;
    assert.equal(deliveryId, envelope.deliveryId);
    return this.history;
  }

  async append(
    attempt: NotificationDeliveryAttemptRecord,
  ): Promise<NotificationDeliveryAttemptAppendResult> {
    this.appendCalls += 1;
    if (this.appendMode === "THROW_BEFORE") {
      throw new Error("simulated write failure before durable append");
    }

    this.history = appendNotificationDeliveryAttempt(this.history, attempt);
    if (this.appendMode === "THROW_AFTER") {
      throw new Error("simulated response ambiguity after durable append");
    }
    return { kind: "APPENDED" };
  }
}

class FakeClaimBoundary
  implements NotificationDeliveryDispatchClaimStore, NotificationDeliveryDispatchClaimRecoveryReader
{
  snapshot: NotificationDeliveryDispatchClaimSnapshot | null = null;
  claimCalls = 0;
  readCalls = 0;
  claimMode: "CLAIMED" | "ALREADY_CLAIMED" | "THROW_AFTER" = "CLAIMED";
  hideSnapshotAfterClaim = false;

  setSnapshot(attemptedAtValue: string): void {
    this.snapshot = {
      schemaVersion: 1,
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      deliveryId: envelope.deliveryId,
      attemptNumber: 1,
      transitionId: envelope.transitionId,
      targetKey: envelope.targetKey,
      attemptedAt: attemptedAtValue,
    };
  }

  async readSnapshot(
    deliveryId: string,
    attemptNumber: number,
  ): Promise<NotificationDeliveryDispatchClaimRecoveryEvidence> {
    this.readCalls += 1;
    assert.equal(deliveryId, envelope.deliveryId);
    assert.equal(attemptNumber, 1);
    if (this.hideSnapshotAfterClaim && this.claimCalls > 0) return { kind: "NOT_CLAIMED" };
    return this.snapshot
      ? { kind: "CLAIMED", claim: this.snapshot }
      : { kind: "NOT_CLAIMED" };
  }

  async claim(
    attempt: NotificationDeliveryDispatchAttempt,
  ): Promise<NotificationDeliveryDispatchClaimResult> {
    this.claimCalls += 1;
    this.snapshot = {
      schemaVersion: 1,
      dispatchId: attempt.dispatchId,
      deliveryId: attempt.deliveryId,
      attemptNumber: attempt.attemptNumber,
      transitionId: attempt.envelope.transitionId,
      targetKey: attempt.envelope.targetKey,
      attemptedAt: attempt.attemptedAt,
    };

    if (this.claimMode === "THROW_AFTER") {
      throw new Error("simulated ambiguous claim response after durable write");
    }
    return { kind: this.claimMode };
  }
}

class FakeAdapter implements NotificationDeliveryDispatchAdapter {
  calls = 0;
  result: NotificationDeliveryResult = { kind: "DELIVERED" };
  error: Error | null = null;

  async deliver(attempt: NotificationDeliveryDispatchAttempt): Promise<NotificationDeliveryResult> {
    this.calls += 1;
    assert.equal(attempt.deliveryId, envelope.deliveryId);
    if (this.error) throw this.error;
    return this.result;
  }
}

function dependencies(history = historyWith()) {
  const attemptStore = new FakeAttemptStore(history);
  const claimBoundary = new FakeClaimBoundary();
  const adapter = new FakeAdapter();
  return {
    attemptStore,
    claimReader: claimBoundary,
    claimStore: claimBoundary,
    adapter,
    claimBoundary,
  };
}

test("pre-recorded durable evidence returns without claiming or invoking provider", async () => {
  const result: NotificationDeliveryResult = { kind: "DELIVERED" };
  const deps = dependencies(historyWith(record(attemptedAt, result)));
  deps.claimBoundary.setSnapshot(attemptedAt);

  assert.deepEqual(
    await coordinateNotificationDeliveryDispatch(envelope, readyDecision, "2026-08-20T10:00:00.000Z", deps),
    {
      kind: "RECORDED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
      attemptedAt,
      result,
      evidence: "RECOVERY",
    },
  );
  assert.equal(deps.claimBoundary.claimCalls, 0);
  assert.equal(deps.adapter.calls, 0);
});

test("pre-existing ambiguous durable claim is a no-send replay barrier", async () => {
  const deps = dependencies();
  deps.claimBoundary.setSnapshot(attemptedAt);

  assert.deepEqual(
    await coordinateNotificationDeliveryDispatch(envelope, readyDecision, "2026-08-20T10:00:00.000Z", deps),
    {
      kind: "AMBIGUOUS_CLAIMED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
      attemptedAt,
    },
  );
  assert.equal(deps.claimBoundary.claimCalls, 0);
  assert.equal(deps.adapter.calls, 0);
});

test("clean NOT_STARTED state executes exactly once and returns durable result", async () => {
  const deps = dependencies();

  assert.deepEqual(
    await coordinateNotificationDeliveryDispatch(envelope, readyDecision, attemptedAt, deps),
    {
      kind: "RECORDED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
      attemptedAt,
      result: { kind: "DELIVERED" },
      evidence: "EXECUTION",
    },
  );
  assert.equal(deps.claimBoundary.claimCalls, 1);
  assert.equal(deps.adapter.calls, 1);
  assert.equal(deps.attemptStore.appendCalls, 1);
  assert.equal(deps.attemptStore.history.status, "DELIVERED");
});

test("ALREADY_CLAIMED race performs one restart-safe recovery and never sends", async () => {
  const deps = dependencies();
  deps.claimBoundary.claimMode = "ALREADY_CLAIMED";

  assert.deepEqual(
    await coordinateNotificationDeliveryDispatch(envelope, readyDecision, attemptedAt, deps),
    {
      kind: "AMBIGUOUS_CLAIMED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
      attemptedAt,
    },
  );
  assert.equal(deps.claimBoundary.claimCalls, 1);
  assert.equal(deps.claimBoundary.readCalls, 2);
  assert.equal(deps.adapter.calls, 0);
});

test("provider ambiguity recovers the durable claim and does not execute twice", async () => {
  const deps = dependencies();
  deps.adapter.error = new Error("provider outcome unknown");

  assert.deepEqual(
    await coordinateNotificationDeliveryDispatch(envelope, readyDecision, attemptedAt, deps),
    {
      kind: "AMBIGUOUS_CLAIMED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
      attemptedAt,
    },
  );
  assert.equal(deps.adapter.calls, 1);
  assert.equal(deps.claimBoundary.claimCalls, 1);
  assert.equal(deps.claimBoundary.readCalls, 2);
});

test("durable append followed by response ambiguity is recovered as RECORDED", async () => {
  const deps = dependencies();
  deps.attemptStore.appendMode = "THROW_AFTER";

  assert.deepEqual(
    await coordinateNotificationDeliveryDispatch(envelope, readyDecision, attemptedAt, deps),
    {
      kind: "RECORDED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
      attemptedAt,
      result: { kind: "DELIVERED" },
      evidence: "RECOVERY",
    },
  );
  assert.equal(deps.adapter.calls, 1);
  assert.equal(deps.attemptStore.appendCalls, 1);
  assert.equal(deps.attemptStore.history.status, "DELIVERED");
});

test("ambiguous claim response recovers the durable claim without provider invocation", async () => {
  const deps = dependencies();
  deps.claimBoundary.claimMode = "THROW_AFTER";

  assert.deepEqual(
    await coordinateNotificationDeliveryDispatch(envelope, readyDecision, attemptedAt, deps),
    {
      kind: "AMBIGUOUS_CLAIMED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
      attemptedAt,
    },
  );
  assert.equal(deps.claimBoundary.claimCalls, 1);
  assert.equal(deps.adapter.calls, 0);
});

test("ALREADY_CLAIMED with no durable post-race evidence fails closed", async () => {
  const deps = dependencies();
  deps.claimBoundary.claimMode = "ALREADY_CLAIMED";
  deps.claimBoundary.hideSnapshotAfterClaim = true;

  await assert.rejects(
    () => coordinateNotificationDeliveryDispatch(envelope, readyDecision, attemptedAt, deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchCoordinatorError &&
      error.code === "POST_EXECUTION_EVIDENCE_INCONSISTENT",
  );
  assert.equal(deps.adapter.calls, 0);
  assert.equal(deps.claimBoundary.claimCalls, 1);
});

test("invalid non-READY input fails before durable reads", async () => {
  const deps = dependencies();
  const waitDecision: NotificationDeliveryDispatchDecision = {
    kind: "WAIT",
    attemptNumber: 1,
    eligibleAt: "2026-08-20T10:00:00.000Z",
  };

  await assert.rejects(
    () => coordinateNotificationDeliveryDispatch(envelope, waitDecision, attemptedAt, deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchCoordinatorError &&
      error.code === "INVALID_INPUT",
  );
  assert.equal(deps.attemptStore.readCalls, 0);
  assert.equal(deps.claimBoundary.readCalls, 0);
  assert.equal(deps.claimBoundary.claimCalls, 0);
  assert.equal(deps.adapter.calls, 0);
});

test("coordinator remains detached from Worker, Queue and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /notification-delivery-dispatch-coordinator|coordinateNotificationDeliveryDispatch/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
