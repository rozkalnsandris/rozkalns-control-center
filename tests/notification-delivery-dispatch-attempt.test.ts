import assert from "node:assert/strict";
import test from "node:test";

import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
} from "../src/shared/notification-delivery.js";
import {
  NotificationDeliveryDispatchAttemptError,
  notificationDeliveryDispatchAttempt,
  type NotificationDeliveryDispatchAdapter,
} from "../src/shared/notification-delivery-dispatch-attempt.js";
import type { NotificationDeliveryDispatchDecision } from "../src/shared/notification-delivery-dispatch-decision.js";
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

function ready(
  attemptNumber: number,
  eligibleAt = "2026-08-20T07:40:00.000Z",
): NotificationDeliveryDispatchDecision {
  return {
    kind: "READY",
    attemptNumber,
    eligibleAt,
  };
}

function expectAttemptError(
  code: NotificationDeliveryDispatchAttemptError["code"],
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof NotificationDeliveryDispatchAttemptError && error.code === code;
}

test("dispatch identity is deterministic for one delivery and attempt number", () => {
  const first = notificationDeliveryDispatchAttempt(
    envelope,
    ready(1),
    "2026-08-20T07:40:00.000Z",
  );
  const second = notificationDeliveryDispatchAttempt(
    { ...envelope },
    ready(1),
    "2026-08-20T07:41:00.000Z",
  );

  assert.equal(first.dispatchId, second.dispatchId);
  assert.match(first.dispatchId, /^dispatch-v1-[0-9a-f]{16}-1$/);
  assert.equal(first.deliveryId, envelope.deliveryId);
  assert.equal(first.attemptNumber, 1);
});

test("different attempt numbers have distinct dispatch identities", () => {
  const first = notificationDeliveryDispatchAttempt(
    envelope,
    ready(1),
    "2026-08-20T07:40:00.000Z",
  );
  const retry = notificationDeliveryDispatchAttempt(
    envelope,
    ready(2, "2026-08-20T07:45:00.000Z"),
    "2026-08-20T07:45:00.000Z",
  );

  assert.notEqual(first.dispatchId, retry.dispatchId);
  assert.match(retry.dispatchId, /^dispatch-v1-[0-9a-f]{16}-2$/);
});

test("dispatch attempt preserves only bounded provider-neutral evidence", () => {
  const attempt = notificationDeliveryDispatchAttempt(
    envelope,
    ready(3),
    "2026-08-20T07:40:01Z",
  );

  assert.deepEqual(attempt, {
    schemaVersion: 1,
    dispatchId: `dispatch-v1-${envelope.deliveryId.slice("delivery-v1-".length)}-3`,
    deliveryId: envelope.deliveryId,
    attemptNumber: 3,
    attemptedAt: "2026-08-20T07:40:01.000Z",
    envelope,
  });

  assert.equal("token" in attempt, false);
  assert.equal("secret" in attempt, false);
  assert.equal("credential" in attempt, false);
  assert.equal("destinationToken" in attempt, false);
});

test("attempt cannot be created before exact eligibility", () => {
  assert.throws(
    () =>
      notificationDeliveryDispatchAttempt(
        envelope,
        ready(2, "2026-08-20T07:45:00.000Z"),
        "2026-08-20T07:44:59.999Z",
      ),
    expectAttemptError("BEFORE_ELIGIBLE"),
  );

  assert.doesNotThrow(() =>
    notificationDeliveryDispatchAttempt(
      envelope,
      ready(2, "2026-08-20T07:45:00.000Z"),
      "2026-08-20T07:45:00.000Z",
    ),
  );
});

test("only READY decisions inside the explicit retry bound are accepted", () => {
  const invalidDecisions: NotificationDeliveryDispatchDecision[] = [
    { kind: "WAIT", attemptNumber: 1, eligibleAt: "2026-08-20T07:45:00.000Z" },
    { kind: "EXHAUSTED", attemptCount: 4, maxAttempts: 4 },
    { kind: "DELIVERED" },
    { kind: "TERMINAL_FAILURE" },
    ready(0),
    ready(9),
  ];

  for (const decision of invalidDecisions) {
    assert.throws(
      () =>
        notificationDeliveryDispatchAttempt(
          envelope,
          decision,
          "2026-08-20T07:45:00.000Z",
        ),
      expectAttemptError("INVALID_DECISION"),
    );
  }
});

test("malformed timestamps fail closed", () => {
  assert.throws(
    () => notificationDeliveryDispatchAttempt(envelope, ready(1, "2026-08-20T09:40:00+02:00"), "2026-08-20T07:40:00.000Z"),
    expectAttemptError("INVALID_TIMESTAMP"),
  );

  assert.throws(
    () => notificationDeliveryDispatchAttempt(envelope, ready(1), "2026-08-20 07:40:00"),
    expectAttemptError("INVALID_TIMESTAMP"),
  );
});

test("delivery envelope identity drift fails closed", () => {
  const drifted = {
    ...envelope,
    deliveryId: "delivery-v1-ffffffffffffffff",
  } as NotificationDeliveryEnvelope;

  assert.throws(
    () => notificationDeliveryDispatchAttempt(drifted, ready(1), "2026-08-20T07:40:00.000Z"),
    expectAttemptError("INVALID_ENVELOPE"),
  );
});

test("provider-neutral adapter boundary receives the exact dispatch attempt", async () => {
  let observedDispatchId: string | null = null;
  const adapter: NotificationDeliveryDispatchAdapter = {
    async deliver(attempt) {
      observedDispatchId = attempt.dispatchId;
      return { kind: "DELIVERED" };
    },
  };

  const attempt = notificationDeliveryDispatchAttempt(
    envelope,
    ready(1),
    "2026-08-20T07:40:00.000Z",
  );
  const result = await adapter.deliver(attempt);

  assert.equal(observedDispatchId, attempt.dispatchId);
  assert.deepEqual(result, { kind: "DELIVERED" });
});
