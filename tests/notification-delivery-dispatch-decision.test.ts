import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  NotificationDeliveryAttemptContractError,
  appendNotificationDeliveryAttempt,
  notificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptRecord,
} from "../src/shared/notification-delivery-attempt.js";
import {
  NotificationDeliveryDispatchDecisionError,
  notificationDeliveryDispatchDecision,
} from "../src/shared/notification-delivery-dispatch-decision.js";
import {
  NotificationDeliveryRetryPolicyError,
  type NotificationDeliveryRetryPolicy,
} from "../src/shared/notification-delivery-retry-policy.js";

const DELIVERY_ID = "delivery-v1-0123456789abcdef";
const QUEUED_AT = "2026-08-20T05:20:00.000Z";
const POLICY: NotificationDeliveryRetryPolicy = {
  schemaVersion: 1,
  maxAttempts: 3,
  retryDelaysSeconds: [60, 300],
};

function attempt(
  attemptNumber: number,
  attemptedAt: string,
  result: NotificationDeliveryAttemptRecord["result"],
): NotificationDeliveryAttemptRecord {
  return {
    schemaVersion: 1,
    deliveryId: DELIVERY_ID,
    attemptNumber,
    attemptedAt,
    result,
  };
}

function decide(
  history: NotificationDeliveryAttemptHistory,
  observedAt: string,
  retryPolicy: NotificationDeliveryRetryPolicy = POLICY,
) {
  return notificationDeliveryDispatchDecision({
    deliveryId: DELIVERY_ID,
    queuedAt: QUEUED_AT,
    observedAt,
    history,
    retryPolicy,
  });
}

test("first attempt waits until queued-at and becomes ready exactly at the boundary", () => {
  const history = notificationDeliveryAttemptHistory(DELIVERY_ID);

  assert.deepEqual(decide(history, "2026-08-20T05:19:59.999Z"), {
    kind: "WAIT",
    attemptNumber: 1,
    eligibleAt: QUEUED_AT,
  });
  assert.deepEqual(decide(history, QUEUED_AT), {
    kind: "READY",
    attemptNumber: 1,
    eligibleAt: QUEUED_AT,
  });
  assert.deepEqual(decide(history, "2026-08-20T05:30:00.000Z"), {
    kind: "READY",
    attemptNumber: 1,
    eligibleAt: QUEUED_AT,
  });
});

test("retry wait and ready boundaries reuse the explicit retry policy exactly", () => {
  const history = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, QUEUED_AT, {
      kind: "RETRYABLE_FAILURE",
      reason: "TRANSIENT_UPSTREAM",
    }),
  );

  assert.deepEqual(decide(history, "2026-08-20T05:20:59.999Z"), {
    kind: "WAIT",
    attemptNumber: 2,
    eligibleAt: "2026-08-20T05:21:00.000Z",
  });
  assert.deepEqual(decide(history, "2026-08-20T05:21:00.000Z"), {
    kind: "READY",
    attemptNumber: 2,
    eligibleAt: "2026-08-20T05:21:00.000Z",
  });
});

test("retryable history at the explicit ceiling is exhausted", () => {
  let history = notificationDeliveryAttemptHistory(DELIVERY_ID);
  history = appendNotificationDeliveryAttempt(
    history,
    attempt(1, QUEUED_AT, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }),
  );
  history = appendNotificationDeliveryAttempt(
    history,
    attempt(2, "2026-08-20T05:21:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "PROVIDER_UNAVAILABLE",
    }),
  );
  history = appendNotificationDeliveryAttempt(
    history,
    attempt(3, "2026-08-20T05:26:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "TRANSIENT_UPSTREAM",
    }),
  );

  assert.deepEqual(decide(history, "2026-08-20T06:00:00.000Z"), {
    kind: "EXHAUSTED",
    attemptCount: 3,
    maxAttempts: 3,
  });
});

test("delivered and terminal histories remain final regardless of observation time", () => {
  const delivered = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, QUEUED_AT, { kind: "DELIVERED" }),
  );
  assert.deepEqual(decide(delivered, "2026-08-21T05:20:00.000Z"), { kind: "DELIVERED" });

  const terminal = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, QUEUED_AT, {
      kind: "TERMINAL_FAILURE",
      reason: "DESTINATION_INVALID",
    }),
  );
  assert.deepEqual(decide(terminal, "2026-08-21T05:20:00.000Z"), {
    kind: "TERMINAL_FAILURE",
  });
});

test("delivery identity is bound exactly to the validated attempt history", () => {
  assert.throws(
    () =>
      notificationDeliveryDispatchDecision({
        deliveryId: "delivery-v1-fedcba9876543210",
        queuedAt: QUEUED_AT,
        observedAt: QUEUED_AT,
        history: notificationDeliveryAttemptHistory(DELIVERY_ID),
        retryPolicy: POLICY,
      }),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchDecisionError &&
      error.code === "DELIVERY_ID_MISMATCH",
  );
});

test("queued-at and observed-at must be explicit UTC timestamps", () => {
  const history = notificationDeliveryAttemptHistory(DELIVERY_ID);

  for (const input of [
    { queuedAt: "2026-08-20T07:20:00+02:00", observedAt: QUEUED_AT },
    { queuedAt: QUEUED_AT, observedAt: "not-a-time" },
  ]) {
    assert.throws(
      () =>
        notificationDeliveryDispatchDecision({
          deliveryId: DELIVERY_ID,
          queuedAt: input.queuedAt,
          observedAt: input.observedAt,
          history,
          retryPolicy: POLICY,
        }),
      (error: unknown) =>
        error instanceof NotificationDeliveryDispatchDecisionError &&
        error.code === "INVALID_TIMESTAMP",
    );
  }
});

test("attempt evidence cannot move backwards relative to queued-at or prior attempts", () => {
  const beforeQueue = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, "2026-08-20T05:19:59.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
  );
  assert.throws(
    () => decide(beforeQueue, QUEUED_AT),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchDecisionError &&
      error.code === "INVALID_TIMELINE",
  );

  let backwards = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, "2026-08-20T05:25:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
  );
  backwards = appendNotificationDeliveryAttempt(
    backwards,
    attempt(2, "2026-08-20T05:24:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
  );
  assert.throws(
    () => decide(backwards, "2026-08-20T06:00:00.000Z"),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchDecisionError &&
      error.code === "INVALID_TIMELINE",
  );
});

test("malformed history and retry policy still fail closed through their owning contracts", () => {
  const malformedHistory = {
    schemaVersion: 1,
    deliveryId: DELIVERY_ID,
    status: "RETRY_ELIGIBLE",
    attempts: [
      attempt(2, QUEUED_AT, {
        kind: "RETRYABLE_FAILURE",
        reason: "TRANSIENT_UPSTREAM",
      }),
    ],
  } as NotificationDeliveryAttemptHistory;

  assert.throws(
    () => decide(malformedHistory, QUEUED_AT),
    (error: unknown) => error instanceof NotificationDeliveryAttemptContractError,
  );

  const invalidPolicy = {
    schemaVersion: 1,
    maxAttempts: 0,
    retryDelaysSeconds: [],
  } as NotificationDeliveryRetryPolicy;
  assert.throws(
    () => decide(notificationDeliveryAttemptHistory(DELIVERY_ID), QUEUED_AT, invalidPolicy),
    (error: unknown) => error instanceof NotificationDeliveryRetryPolicyError,
  );
});

test("dispatch decision contract remains detached from Worker and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /notification-delivery-dispatch-decision|notificationDeliveryDispatchDecision/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
