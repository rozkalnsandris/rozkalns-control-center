import assert from "node:assert/strict";
import test from "node:test";

import {
  NotificationDeliveryAttemptContractError,
  appendNotificationDeliveryAttempt,
  notificationDeliveryAttemptCanRetry,
  notificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptRecord,
} from "../src/shared/notification-delivery-attempt.js";

const DELIVERY_ID = "delivery-v1-0123456789abcdef";

function attempt(
  attemptNumber: number,
  result: NotificationDeliveryAttemptRecord["result"],
  overrides: Partial<NotificationDeliveryAttemptRecord> = {},
): NotificationDeliveryAttemptRecord {
  return {
    schemaVersion: 1,
    deliveryId: DELIVERY_ID,
    attemptNumber,
    attemptedAt: `2026-08-20T05:${String(20 + attemptNumber).padStart(2, "0")}:00.000Z`,
    result,
    ...overrides,
  };
}

function expectCode(code: NotificationDeliveryAttemptContractError["code"]) {
  return (error: unknown) =>
    error instanceof NotificationDeliveryAttemptContractError && error.code === code;
}

test("new delivery starts pending and first retryable result enables only the next attempt", () => {
  const initial = notificationDeliveryAttemptHistory(DELIVERY_ID);
  assert.deepEqual(initial, {
    schemaVersion: 1,
    deliveryId: DELIVERY_ID,
    status: "PENDING",
    attempts: [],
  });
  assert.equal(notificationDeliveryAttemptCanRetry(initial), false);

  const afterFirst = appendNotificationDeliveryAttempt(
    initial,
    attempt(1, { kind: "RETRYABLE_FAILURE", reason: "TRANSIENT_UPSTREAM" }),
  );

  assert.equal(afterFirst.status, "RETRY_ELIGIBLE");
  assert.equal(afterFirst.attempts.length, 1);
  assert.equal(notificationDeliveryAttemptCanRetry(afterFirst), true);

  const afterSecond = appendNotificationDeliveryAttempt(
    afterFirst,
    attempt(2, { kind: "DELIVERED" }),
  );
  assert.equal(afterSecond.status, "DELIVERED");
  assert.equal(notificationDeliveryAttemptCanRetry(afterSecond), false);
});

test("delivered and terminal failures are final", () => {
  const delivered = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, { kind: "DELIVERED" }),
  );
  assert.equal(delivered.status, "DELIVERED");
  assert.throws(
    () =>
      appendNotificationDeliveryAttempt(
        delivered,
        attempt(2, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }),
      ),
    expectCode("FINAL_STATE"),
  );

  const terminal = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, { kind: "TERMINAL_FAILURE", reason: "DESTINATION_INVALID" }),
  );
  assert.equal(terminal.status, "TERMINAL_FAILURE");
  assert.throws(
    () => appendNotificationDeliveryAttempt(terminal, attempt(2, { kind: "DELIVERED" })),
    expectCode("FINAL_STATE"),
  );
});

test("attempt numbers are exact and replay or gaps fail closed", () => {
  const initial = notificationDeliveryAttemptHistory(DELIVERY_ID);
  assert.throws(
    () =>
      appendNotificationDeliveryAttempt(
        initial,
        attempt(2, { kind: "RETRYABLE_FAILURE", reason: "PROVIDER_UNAVAILABLE" }),
      ),
    expectCode("ATTEMPT_SEQUENCE_MISMATCH"),
  );

  const retryable = appendNotificationDeliveryAttempt(
    initial,
    attempt(1, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }),
  );
  assert.throws(
    () =>
      appendNotificationDeliveryAttempt(
        retryable,
        attempt(1, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }),
      ),
    expectCode("ATTEMPT_SEQUENCE_MISMATCH"),
  );
  assert.throws(
    () => appendNotificationDeliveryAttempt(retryable, attempt(3, { kind: "DELIVERED" })),
    expectCode("ATTEMPT_SEQUENCE_MISMATCH"),
  );
});

test("cross-delivery attempts are rejected", () => {
  const initial = notificationDeliveryAttemptHistory(DELIVERY_ID);
  assert.throws(
    () =>
      appendNotificationDeliveryAttempt(
        initial,
        attempt(1, { kind: "DELIVERED" }, { deliveryId: "delivery-v1-fedcba9876543210" }),
      ),
    expectCode("DELIVERY_ID_MISMATCH"),
  );
});

test("malformed timestamp, attempt number and unsupported result reason fail closed", () => {
  const initial = notificationDeliveryAttemptHistory(DELIVERY_ID);

  assert.throws(
    () =>
      appendNotificationDeliveryAttempt(
        initial,
        attempt(1, { kind: "DELIVERED" }, { attemptedAt: "2026-08-20T07:20:00+02:00" }),
      ),
    expectCode("INVALID_ATTEMPT"),
  );
  assert.throws(
    () => appendNotificationDeliveryAttempt(initial, attempt(0, { kind: "DELIVERED" })),
    expectCode("INVALID_ATTEMPT"),
  );

  assert.doesNotThrow(() =>
    appendNotificationDeliveryAttempt(
      initial,
      attempt(1, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }),
    ),
  );

  const invalidReason = attempt(1, {
    kind: "RETRYABLE_FAILURE",
    reason: "RATE_LIMITED",
  }) as unknown as NotificationDeliveryAttemptRecord;
  (invalidReason as { result: unknown }).result = {
    kind: "RETRYABLE_FAILURE",
    reason: "UNKNOWN_PROVIDER_REASON",
  };
  assert.throws(
    () => appendNotificationDeliveryAttempt(initial, invalidReason),
    expectCode("INVALID_ATTEMPT"),
  );
});

test("malformed prior history is rejected before appending", () => {
  const retryableAttempt = attempt(1, {
    kind: "RETRYABLE_FAILURE",
    reason: "TRANSIENT_UPSTREAM",
  });

  const wrongStatus: NotificationDeliveryAttemptHistory = {
    schemaVersion: 1,
    deliveryId: DELIVERY_ID,
    status: "DELIVERED",
    attempts: [retryableAttempt],
  };
  assert.throws(
    () => appendNotificationDeliveryAttempt(wrongStatus, attempt(2, { kind: "DELIVERED" })),
    expectCode("INVALID_HISTORY"),
  );

  const finalThenRetry = {
    schemaVersion: 1,
    deliveryId: DELIVERY_ID,
    status: "RETRY_ELIGIBLE",
    attempts: [
      attempt(1, { kind: "DELIVERED" }),
      attempt(2, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }),
    ],
  } as NotificationDeliveryAttemptHistory;
  assert.throws(
    () => appendNotificationDeliveryAttempt(finalThenRetry, attempt(3, { kind: "DELIVERED" })),
    expectCode("INVALID_HISTORY"),
  );
});
