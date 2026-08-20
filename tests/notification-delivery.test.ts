import assert from "node:assert/strict";
import test from "node:test";

import {
  NotificationDeliveryContractError,
  notificationDeliveryEnvelope,
  notificationDeliveryId,
  notificationDeliveryShouldRetry,
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

test("delivery identity is deterministic for one transition and target", () => {
  const first = notificationDeliveryId(candidate, "primary");
  const second = notificationDeliveryId({ ...candidate }, "primary");

  assert.equal(first, second);
  assert.match(first, /^delivery-v1-[0-9a-f]{16}$/);
});

test("different target keys produce separate delivery identities", () => {
  assert.notEqual(
    notificationDeliveryId(candidate, "primary"),
    notificationDeliveryId(candidate, "backup"),
  );
});

test("delivery envelope preserves bounded candidate evidence and exact deep link", () => {
  const envelope = notificationDeliveryEnvelope(candidate, "primary");

  assert.deepEqual(envelope, {
    schemaVersion: 1,
    deliveryId: notificationDeliveryId(candidate, "primary"),
    targetKey: "primary",
    transitionId: candidate.transitionId,
    signal: candidate.signal,
    decisionId: candidate.decisionId,
    projectId: candidate.projectId,
    reference: candidate.reference,
    title: candidate.title,
    body: candidate.body,
    deepLinkPath: candidate.deepLinkPath,
  });

  assert.equal("token" in envelope, false);
  assert.equal("secret" in envelope, false);
  assert.equal("credential" in envelope, false);
});

test("target key is bounded and rejects whitespace or control-like routing labels", () => {
  for (const targetKey of ["", "Primary", "primary target", "primary\n", "a".repeat(65)]) {
    assert.throws(
      () => notificationDeliveryEnvelope(candidate, targetKey),
      (error: unknown) =>
        error instanceof NotificationDeliveryContractError &&
        error.code === "INVALID_TARGET_KEY",
    );
  }
});

test("candidate validation fails closed before a provider adapter can receive unsafe data", () => {
  const unsafeCandidate = {
    ...candidate,
    title: "unsafe\nprovider payload",
  } as NotificationCandidate;

  assert.throws(
    () => notificationDeliveryEnvelope(unsafeCandidate, "primary"),
    (error: unknown) =>
      error instanceof NotificationDeliveryContractError &&
      error.code === "INVALID_CANDIDATE",
  );

  const badDeepLink = {
    ...candidate,
    deepLinkPath: "https://example.invalid/decision",
  } as NotificationCandidate;

  assert.throws(
    () => notificationDeliveryEnvelope(badDeepLink, "primary"),
    (error: unknown) =>
      error instanceof NotificationDeliveryContractError &&
      error.code === "INVALID_CANDIDATE",
  );
});

test("retry semantics are explicit and provider-neutral", () => {
  assert.equal(notificationDeliveryShouldRetry({ kind: "DELIVERED" }), false);
  assert.equal(
    notificationDeliveryShouldRetry({
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
    true,
  );
  assert.equal(
    notificationDeliveryShouldRetry({
      kind: "TERMINAL_FAILURE",
      reason: "DESTINATION_INVALID",
    }),
    false,
  );
});
