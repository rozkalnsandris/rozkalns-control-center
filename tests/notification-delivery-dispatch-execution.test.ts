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
  notificationDeliveryDispatchAttempt,
  type NotificationDeliveryDispatchAdapter,
  type NotificationDeliveryDispatchAttempt,
} from "../src/shared/notification-delivery-dispatch-attempt.js";
import type {
  NotificationDeliveryDispatchClaimResult,
  NotificationDeliveryDispatchClaimStore,
} from "../src/shared/notification-delivery-dispatch-claim-store.js";
import {
  executeNotificationDeliveryDispatch,
  NotificationDeliveryDispatchExecutionError,
} from "../src/shared/notification-delivery-dispatch-execution.js";
import { notificationDeliveryEnvelope, type NotificationDeliveryResult } from "../src/shared/notification-delivery.js";
import type { NotificationCandidate } from "../src/shared/notification-transition.js";

const candidate: NotificationCandidate = {
  schemaVersion: 1,
  signal: "CI_FAILED",
  transitionId: "notification-v1-ci-failed-0123456789abcdef",
  decisionId: "github:hermes-deals:pr:517",
  projectId: "hermes-deals",
  reference: "PR #517",
  title: "Fix Lidl weekly offer import",
  body: "CI failed after the latest source change",
  deepLinkPath: "/#decision-6769746875623a6865726d65732d6465616c733a70723a353137",
};

const envelope = notificationDeliveryEnvelope(candidate, "primary");

function dispatchAttempt(
  attemptNumber = 1,
  attemptedAt = "2026-08-20T08:30:00.000Z",
): NotificationDeliveryDispatchAttempt {
  return notificationDeliveryDispatchAttempt(
    envelope,
    {
      kind: "READY",
      attemptNumber,
      eligibleAt: attemptNumber === 1
        ? "2026-08-20T08:00:00.000Z"
        : "2026-08-20T08:20:00.000Z",
    },
    attemptedAt,
  );
}

class FakeAttemptStore implements NotificationDeliveryAttemptStore {
  readonly events: string[];
  history: NotificationDeliveryAttemptHistory;
  appendResult: NotificationDeliveryAttemptAppendResult = { kind: "APPENDED" };
  appendError: Error | null = null;
  onRead: ((readNumber: number, store: FakeAttemptStore) => void) | null = null;
  readCount = 0;

  constructor(events: string[], history = notificationDeliveryAttemptHistory(envelope.deliveryId)) {
    this.events = events;
    this.history = history;
  }

  async readHistory(deliveryId: string): Promise<NotificationDeliveryAttemptHistory> {
    this.events.push("history.read");
    this.readCount += 1;
    assert.equal(deliveryId, envelope.deliveryId);
    this.onRead?.(this.readCount, this);
    return this.history;
  }

  async append(
    attempt: NotificationDeliveryAttemptRecord,
  ): Promise<NotificationDeliveryAttemptAppendResult> {
    this.events.push("attempt.append");
    if (this.appendError) throw this.appendError;
    if (this.appendResult.kind === "APPENDED") {
      this.history = appendNotificationDeliveryAttempt(this.history, attempt);
    }
    return this.appendResult;
  }
}

class FakeClaimStore implements NotificationDeliveryDispatchClaimStore {
  readonly events: string[];
  result: NotificationDeliveryDispatchClaimResult = { kind: "CLAIMED" };
  error: Error | null = null;

  constructor(events: string[]) {
    this.events = events;
  }

  async claim(attempt: NotificationDeliveryDispatchAttempt): Promise<NotificationDeliveryDispatchClaimResult> {
    this.events.push("claim");
    assert.equal(attempt.dispatchId, dispatchAttempt(attempt.attemptNumber, attempt.attemptedAt).dispatchId);
    if (this.error) throw this.error;
    return this.result;
  }
}

class FakeAdapter implements NotificationDeliveryDispatchAdapter {
  readonly events: string[];
  result: NotificationDeliveryResult = { kind: "DELIVERED" };
  error: Error | null = null;
  calls = 0;

  constructor(events: string[]) {
    this.events = events;
  }

  async deliver(attempt: NotificationDeliveryDispatchAttempt): Promise<NotificationDeliveryResult> {
    this.events.push("adapter.deliver");
    this.calls += 1;
    assert.equal(attempt.deliveryId, envelope.deliveryId);
    if (this.error) throw this.error;
    return this.result;
  }
}

function dependencies(events: string[], history?: NotificationDeliveryAttemptHistory) {
  const attemptStore = new FakeAttemptStore(events, history);
  const claimStore = new FakeClaimStore(events);
  const adapter = new FakeAdapter(events);
  return { attemptStore, claimStore, adapter };
}

function historyAfterRetryableFirstAttempt(): NotificationDeliveryAttemptHistory {
  return appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(envelope.deliveryId),
    {
      schemaVersion: 1,
      deliveryId: envelope.deliveryId,
      attemptNumber: 1,
      attemptedAt: "2026-08-20T08:10:00.000Z",
      result: { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" },
    },
  );
}

test("execution orders durable history, claim, re-check, one adapter call and durable result", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  const attempt = dispatchAttempt();

  assert.deepEqual(await executeNotificationDeliveryDispatch(attempt, deps), {
    kind: "RECORDED",
    dispatchId: attempt.dispatchId,
    attemptNumber: 1,
    result: { kind: "DELIVERED" },
    persistence: "APPENDED",
  });
  assert.deepEqual(events, [
    "history.read",
    "claim",
    "history.read",
    "adapter.deliver",
    "attempt.append",
  ]);
  assert.equal(deps.adapter.calls, 1);
  assert.equal(deps.attemptStore.history.status, "DELIVERED");
});

test("an existing dispatch claim is a no-send terminal execution outcome", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.claimStore.result = { kind: "ALREADY_CLAIMED" };
  const attempt = dispatchAttempt();

  assert.deepEqual(await executeNotificationDeliveryDispatch(attempt, deps), {
    kind: "ALREADY_CLAIMED",
    dispatchId: attempt.dispatchId,
    attemptNumber: 1,
  });
  assert.deepEqual(events, ["history.read", "claim"]);
  assert.equal(deps.adapter.calls, 0);
});

test("state drift before claim fails closed without claiming or sending", async () => {
  const events: string[] = [];
  const delivered = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(envelope.deliveryId),
    {
      schemaVersion: 1,
      deliveryId: envelope.deliveryId,
      attemptNumber: 1,
      attemptedAt: "2026-08-20T08:10:00.000Z",
      result: { kind: "DELIVERED" },
    },
  );
  const deps = dependencies(events, delivered);

  await assert.rejects(
    () => executeNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchExecutionError &&
      error.code === "ATTEMPT_STATE_MISMATCH",
  );
  assert.deepEqual(events, ["history.read"]);
  assert.equal(deps.adapter.calls, 0);
});

test("state drift after a new claim burns the claim and does not cross provider boundary", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.attemptStore.onRead = (readNumber, store) => {
    if (readNumber !== 2) return;
    store.history = appendNotificationDeliveryAttempt(store.history, {
      schemaVersion: 1,
      deliveryId: envelope.deliveryId,
      attemptNumber: 1,
      attemptedAt: "2026-08-20T08:25:00.000Z",
      result: { kind: "DELIVERED" },
    });
  };

  await assert.rejects(
    () => executeNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchExecutionError &&
      error.code === "ATTEMPT_STATE_MISMATCH",
  );
  assert.deepEqual(events, ["history.read", "claim", "history.read"]);
  assert.equal(deps.adapter.calls, 0);
});

test("retryable and terminal provider results become exact durable attempt evidence", async () => {
  for (const result of [
    { kind: "RETRYABLE_FAILURE", reason: "PROVIDER_UNAVAILABLE" },
    { kind: "TERMINAL_FAILURE", reason: "DESTINATION_INVALID" },
  ] as const satisfies readonly NotificationDeliveryResult[]) {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.adapter.result = result;
    const attempt = dispatchAttempt();

    const execution = await executeNotificationDeliveryDispatch(attempt, deps);
    assert.equal(execution.kind, "RECORDED");
    if (execution.kind === "RECORDED") assert.deepEqual(execution.result, result);
    assert.deepEqual(deps.attemptStore.history.attempts[0]?.result, result);
    assert.equal(deps.adapter.calls, 1);
  }
});

test("second retry attempt requires exact durable retry-eligible history", async () => {
  const events: string[] = [];
  const deps = dependencies(events, historyAfterRetryableFirstAttempt());
  deps.adapter.result = { kind: "DELIVERED" };
  const attempt = dispatchAttempt(2, "2026-08-20T08:30:00.000Z");

  const execution = await executeNotificationDeliveryDispatch(attempt, deps);
  assert.equal(execution.kind, "RECORDED");
  assert.equal(deps.attemptStore.history.status, "DELIVERED");
  assert.equal(deps.attemptStore.history.attempts.length, 2);
});

test("a thrown adapter outcome is ambiguous and never synthesizes retry evidence", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.adapter.error = new Error("simulated provider transport ambiguity");

  await assert.rejects(
    () => executeNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchExecutionError &&
      error.code === "PROVIDER_OUTCOME_AMBIGUOUS",
  );
  assert.deepEqual(events, ["history.read", "claim", "history.read", "adapter.deliver"]);
  assert.equal(deps.adapter.calls, 1);
  assert.equal(deps.attemptStore.history.attempts.length, 0);
});

test("malformed runtime adapter result fails closed before durable append", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.adapter.result = {
    kind: "RETRYABLE_FAILURE",
    reason: "UNKNOWN_REASON",
  } as unknown as NotificationDeliveryResult;

  await assert.rejects(
    () => executeNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchExecutionError &&
      error.code === "INVALID_PROVIDER_RESULT",
  );
  assert.deepEqual(events, ["history.read", "claim", "history.read", "adapter.deliver"]);
  assert.equal(deps.attemptStore.history.attempts.length, 0);
});

test("unconfirmed result persistence fails closed after at most one provider call", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.attemptStore.appendError = new Error("simulated durable write ambiguity");

  await assert.rejects(
    () => executeNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchExecutionError &&
      error.code === "RESULT_PERSISTENCE_UNCONFIRMED",
  );
  assert.deepEqual(events, [
    "history.read",
    "claim",
    "history.read",
    "adapter.deliver",
    "attempt.append",
  ]);
  assert.equal(deps.adapter.calls, 1);
});

test("an exact duplicate durable result is accepted as durable evidence without a resend", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.attemptStore.appendResult = { kind: "DUPLICATE" };
  const attempt = dispatchAttempt();

  assert.deepEqual(await executeNotificationDeliveryDispatch(attempt, deps), {
    kind: "RECORDED",
    dispatchId: attempt.dispatchId,
    attemptNumber: 1,
    result: { kind: "DELIVERED" },
    persistence: "DUPLICATE",
  });
  assert.equal(deps.adapter.calls, 1);
});

test("claim ambiguity fails closed before provider invocation", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.claimStore.error = new Error("simulated claim response ambiguity");

  await assert.rejects(
    () => executeNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchExecutionError &&
      error.code === "CLAIM_UNCONFIRMED",
  );
  assert.deepEqual(events, ["history.read", "claim"]);
  assert.equal(deps.adapter.calls, 0);
});

test("dispatch execution contract remains detached from Worker, Queue and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /notification-delivery-dispatch-execution|executeNotificationDeliveryDispatch/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
