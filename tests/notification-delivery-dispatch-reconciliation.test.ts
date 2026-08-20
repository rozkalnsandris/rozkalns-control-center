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
  type NotificationDeliveryDispatchAttempt,
} from "../src/shared/notification-delivery-dispatch-attempt.js";
import type {
  NotificationDeliveryDispatchClaimEvidence,
  NotificationDeliveryDispatchClaimReader,
} from "../src/shared/notification-delivery-dispatch-claim-store.js";
import {
  reconcileNotificationDeliveryDispatch,
  NotificationDeliveryDispatchReconciliationError,
} from "../src/shared/notification-delivery-dispatch-reconciliation.js";
import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryResult,
} from "../src/shared/notification-delivery.js";
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
      eligibleAt: attemptedAt,
    },
    attemptedAt,
  );
}

function historyWithResult(
  result: NotificationDeliveryResult,
  attemptedAt = "2026-08-20T08:30:00.000Z",
): NotificationDeliveryAttemptHistory {
  return appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(envelope.deliveryId),
    {
      schemaVersion: 1,
      deliveryId: envelope.deliveryId,
      attemptNumber: 1,
      attemptedAt,
      result,
    },
  );
}

class FakeAttemptStore implements NotificationDeliveryAttemptStore {
  readonly events: string[];
  history: NotificationDeliveryAttemptHistory;
  readError: Error | null = null;

  constructor(
    events: string[],
    history = notificationDeliveryAttemptHistory(envelope.deliveryId),
  ) {
    this.events = events;
    this.history = history;
  }

  async readHistory(deliveryId: string): Promise<NotificationDeliveryAttemptHistory> {
    this.events.push("history.read");
    assert.equal(deliveryId, envelope.deliveryId);
    if (this.readError) throw this.readError;
    return this.history;
  }

  async append(
    attempt: NotificationDeliveryAttemptRecord,
  ): Promise<NotificationDeliveryAttemptAppendResult> {
    this.events.push("attempt.append");
    this.history = appendNotificationDeliveryAttempt(this.history, attempt);
    return { kind: "APPENDED" };
  }
}

class FakeClaimReader implements NotificationDeliveryDispatchClaimReader {
  readonly events: string[];
  evidence: NotificationDeliveryDispatchClaimEvidence = { kind: "NOT_CLAIMED" };
  readError: Error | null = null;

  constructor(events: string[]) {
    this.events = events;
  }

  async read(
    attempt: NotificationDeliveryDispatchAttempt,
  ): Promise<NotificationDeliveryDispatchClaimEvidence> {
    this.events.push("claim.read");
    assert.equal(attempt.deliveryId, envelope.deliveryId);
    if (this.readError) throw this.readError;
    return this.evidence;
  }
}

function dependencies(
  events: string[],
  history?: NotificationDeliveryAttemptHistory,
) {
  return {
    attemptStore: new FakeAttemptStore(events, history),
    claimReader: new FakeClaimReader(events),
  };
}

test("an exact next attempt with no durable claim reconciles to NOT_STARTED", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  const attempt = dispatchAttempt();

  assert.deepEqual(await reconcileNotificationDeliveryDispatch(attempt, deps), {
    kind: "NOT_STARTED",
    dispatchId: attempt.dispatchId,
    attemptNumber: 1,
  });
  assert.deepEqual(events, ["history.read", "claim.read"]);
});

test("a durable claim without result evidence is explicit AMBIGUOUS_CLAIMED, never resend permission", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.claimReader.evidence = { kind: "CLAIMED" };
  const attempt = dispatchAttempt();

  assert.deepEqual(await reconcileNotificationDeliveryDispatch(attempt, deps), {
    kind: "AMBIGUOUS_CLAIMED",
    dispatchId: attempt.dispatchId,
    attemptNumber: 1,
  });
  assert.deepEqual(events, ["history.read", "claim.read"]);
});

test("an exact durable claim plus exact result evidence reconciles to RECORDED", async () => {
  const results: NotificationDeliveryResult[] = [
    { kind: "DELIVERED" },
    { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" },
    { kind: "TERMINAL_FAILURE", reason: "PAYLOAD_REJECTED" },
  ];

  for (const result of results) {
    const events: string[] = [];
    const deps = dependencies(events, historyWithResult(result));
    deps.claimReader.evidence = { kind: "CLAIMED" };
    const attempt = dispatchAttempt();

    assert.deepEqual(await reconcileNotificationDeliveryDispatch(attempt, deps), {
      kind: "RECORDED",
      dispatchId: attempt.dispatchId,
      attemptNumber: 1,
      result,
    });
    assert.deepEqual(events, ["history.read", "claim.read"]);
  }
});

test("durable result evidence without the required claim fails closed", async () => {
  const events: string[] = [];
  const deps = dependencies(events, historyWithResult({ kind: "DELIVERED" }));

  await assert.rejects(
    () => reconcileNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchReconciliationError &&
      error.code === "UNCLAIMED_RESULT",
  );
  assert.deepEqual(events, ["history.read", "claim.read"]);
});

test("recorded timestamp drift fails closed before claim evidence is interpreted", async () => {
  const events: string[] = [];
  const deps = dependencies(
    events,
    historyWithResult({ kind: "DELIVERED" }, "2026-08-20T08:29:00.000Z"),
  );
  deps.claimReader.evidence = { kind: "CLAIMED" };

  await assert.rejects(
    () => reconcileNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchReconciliationError &&
      error.code === "RESULT_EVIDENCE_MISMATCH",
  );
  assert.deepEqual(events, ["history.read"]);
});

test("a future or stale attempt slot fails closed instead of becoming NOT_STARTED", async () => {
  const events: string[] = [];
  const deps = dependencies(events);

  await assert.rejects(
    () => reconcileNotificationDeliveryDispatch(dispatchAttempt(2), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchReconciliationError &&
      error.code === "ATTEMPT_STATE_MISMATCH",
  );
  assert.deepEqual(events, ["history.read"]);
});

test("malformed lifecycle history fails closed before claim evidence", async () => {
  const events: string[] = [];
  const malformed = {
    schemaVersion: 1,
    deliveryId: envelope.deliveryId,
    status: "DELIVERED",
    attempts: [],
  } as NotificationDeliveryAttemptHistory;
  const deps = dependencies(events, malformed);

  await assert.rejects(
    () => reconcileNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchReconciliationError &&
      error.code === "ATTEMPT_STATE_MISMATCH",
  );
  assert.deepEqual(events, ["history.read"]);
});

test("attempt-history read failure is unconfirmed evidence, not a dispatch decision", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.attemptStore.readError = new Error("D1 unavailable");

  await assert.rejects(
    () => reconcileNotificationDeliveryDispatch(dispatchAttempt(), deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchReconciliationError &&
      error.code === "ATTEMPT_EVIDENCE_UNCONFIRMED",
  );
  assert.deepEqual(events, ["history.read"]);
});

test("claim read failure or malformed claim evidence fails closed", async () => {
  const readFailureEvents: string[] = [];
  const readFailureDeps = dependencies(readFailureEvents);
  readFailureDeps.claimReader.readError = new Error("D1 unavailable");

  await assert.rejects(
    () => reconcileNotificationDeliveryDispatch(dispatchAttempt(), readFailureDeps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchReconciliationError &&
      error.code === "CLAIM_EVIDENCE_UNCONFIRMED",
  );
  assert.deepEqual(readFailureEvents, ["history.read", "claim.read"]);

  const malformedEvents: string[] = [];
  const malformedDeps = dependencies(malformedEvents);
  malformedDeps.claimReader.evidence = {
    kind: "UNKNOWN",
  } as unknown as NotificationDeliveryDispatchClaimEvidence;

  await assert.rejects(
    () => reconcileNotificationDeliveryDispatch(dispatchAttempt(), malformedDeps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchReconciliationError &&
      error.code === "CLAIM_EVIDENCE_UNCONFIRMED",
  );
  assert.deepEqual(malformedEvents, ["history.read", "claim.read"]);
});

test("malformed dispatch identity fails before durable reads", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  const malformed = {
    ...dispatchAttempt(),
    dispatchId: "dispatch-v1-ffffffffffffffff-1",
  } as NotificationDeliveryDispatchAttempt;

  await assert.rejects(
    () => reconcileNotificationDeliveryDispatch(malformed, deps),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchReconciliationError &&
      error.code === "INVALID_ATTEMPT",
  );
  assert.deepEqual(events, []);
});

test("dispatch reconciliation remains detached from Worker, Queue and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /notification-delivery-dispatch-reconciliation|reconcileNotificationDeliveryDispatch/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
