import assert from "node:assert/strict";
import test from "node:test";

import {
  NotificationDeliveryAttemptContractError,
  appendNotificationDeliveryAttempt,
  notificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptRecord,
} from "../src/shared/notification-delivery-attempt.js";
import {
  NotificationDeliveryRetryPolicyError,
  notificationDeliveryRetryDecision,
  type NotificationDeliveryRetryPolicy,
} from "../src/shared/notification-delivery-retry-policy.js";

const DELIVERY_ID = "delivery-v1-0123456789abcdef";
const POLICY: NotificationDeliveryRetryPolicy = {
  schemaVersion: 1,
  maxAttempts: 4,
  retryDelaysSeconds: [60, 300, 900],
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

function retryableHistory(
  attempts: readonly NotificationDeliveryAttemptRecord[],
): NotificationDeliveryAttemptHistory {
  let history = notificationDeliveryAttemptHistory(DELIVERY_ID);
  for (const record of attempts) {
    history = appendNotificationDeliveryAttempt(history, record);
  }
  return history;
}

function expectPolicyError(error: unknown): boolean {
  return (
    error instanceof NotificationDeliveryRetryPolicyError &&
    error.code === "INVALID_POLICY"
  );
}

test("pending and final histories do not emit retry scheduling evidence", () => {
  const pending = notificationDeliveryAttemptHistory(DELIVERY_ID);
  assert.deepEqual(notificationDeliveryRetryDecision(pending, POLICY), {
    kind: "NOT_RETRY_ELIGIBLE",
  });

  const delivered = appendNotificationDeliveryAttempt(
    pending,
    attempt(1, "2026-08-20T05:20:00.000Z", { kind: "DELIVERED" }),
  );
  assert.deepEqual(notificationDeliveryRetryDecision(delivered, POLICY), {
    kind: "NOT_RETRY_ELIGIBLE",
  });

  const terminal = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, "2026-08-20T05:20:00.000Z", {
      kind: "TERMINAL_FAILURE",
      reason: "DESTINATION_INVALID",
    }),
  );
  assert.deepEqual(notificationDeliveryRetryDecision(terminal, POLICY), {
    kind: "NOT_RETRY_ELIGIBLE",
  });
});

test("retry timing is deterministic from the last attempt timestamp and explicit schedule", () => {
  const history = retryableHistory([
    attempt(1, "2026-08-20T05:20:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "TRANSIENT_UPSTREAM",
    }),
  ]);

  const expected = {
    kind: "RETRY_AT" as const,
    nextAttemptNumber: 2,
    delaySeconds: 60,
    eligibleAt: "2026-08-20T05:21:00.000Z",
  };

  assert.deepEqual(notificationDeliveryRetryDecision(history, POLICY), expected);
  assert.deepEqual(notificationDeliveryRetryDecision(history, POLICY), expected);
});

test("retry schedule advances by exact attempt position", () => {
  const afterSecond = retryableHistory([
    attempt(1, "2026-08-20T05:20:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
    attempt(2, "2026-08-20T05:21:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "PROVIDER_UNAVAILABLE",
    }),
  ]);

  assert.deepEqual(notificationDeliveryRetryDecision(afterSecond, POLICY), {
    kind: "RETRY_AT",
    nextAttemptNumber: 3,
    delaySeconds: 300,
    eligibleAt: "2026-08-20T05:26:00.000Z",
  });

  const afterThird = appendNotificationDeliveryAttempt(
    afterSecond,
    attempt(3, "2026-08-20T05:26:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "TRANSIENT_UPSTREAM",
    }),
  );

  assert.deepEqual(notificationDeliveryRetryDecision(afterThird, POLICY), {
    kind: "RETRY_AT",
    nextAttemptNumber: 4,
    delaySeconds: 900,
    eligibleAt: "2026-08-20T05:41:00.000Z",
  });
});

test("retryable history at the attempt ceiling is exhausted", () => {
  const exhausted = retryableHistory([
    attempt(1, "2026-08-20T05:20:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
    attempt(2, "2026-08-20T05:21:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
    attempt(3, "2026-08-20T05:26:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
    attempt(4, "2026-08-20T05:41:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
  ]);

  assert.deepEqual(notificationDeliveryRetryDecision(exhausted, POLICY), {
    kind: "EXHAUSTED",
    attemptCount: 4,
    maxAttempts: 4,
  });
});

test("retry policy bounds fail closed", () => {
  const history = retryableHistory([
    attempt(1, "2026-08-20T05:20:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "TRANSIENT_UPSTREAM",
    }),
  ]);

  const invalidPolicies = [
    { schemaVersion: 1, maxAttempts: 0, retryDelaysSeconds: [] },
    { schemaVersion: 1, maxAttempts: 9, retryDelaysSeconds: Array(8).fill(60) },
    { schemaVersion: 1, maxAttempts: 3, retryDelaysSeconds: [60] },
    { schemaVersion: 1, maxAttempts: 2, retryDelaysSeconds: [0] },
    { schemaVersion: 1, maxAttempts: 2, retryDelaysSeconds: [86_401] },
    { schemaVersion: 1, maxAttempts: 2, retryDelaysSeconds: [1.5] },
    { schemaVersion: 2, maxAttempts: 2, retryDelaysSeconds: [60] },
  ];

  for (const policy of invalidPolicies) {
    assert.throws(
      () =>
        notificationDeliveryRetryDecision(
          history,
          policy as unknown as NotificationDeliveryRetryPolicy,
        ),
      expectPolicyError,
    );
  }
});

test("malformed attempt history still fails closed through the lifecycle contract", () => {
  const malformed = {
    schemaVersion: 1,
    deliveryId: DELIVERY_ID,
    status: "RETRY_ELIGIBLE",
    attempts: [
      attempt(1, "2026-08-20T07:20:00+02:00", {
        kind: "RETRYABLE_FAILURE",
        reason: "TRANSIENT_UPSTREAM",
      }),
    ],
  } as NotificationDeliveryAttemptHistory;

  assert.throws(
    () => notificationDeliveryRetryDecision(malformed, POLICY),
    (error: unknown) => error instanceof NotificationDeliveryAttemptContractError,
  );
});
