import assert from "node:assert/strict";
import test from "node:test";

import {
  WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT,
  WEBHOOK_DELIVERY_STALE_AFTER_SECONDS,
  classifyWebhookDeliveryObservation,
  isWebhookDeliveryObservabilitySnapshot,
  type WebhookDeliveryObservabilitySnapshot,
} from "../src/shared/webhook-delivery-observability.js";
import {
  MAX_DASHBOARD_CLOCK_SKEW_MS,
  MAX_DASHBOARD_SNAPSHOT_AGE_MS,
} from "../src/shared/dashboard-freshness.js";

const NOW_MS = Date.parse("2026-09-03T10:00:00.000Z");
const OBSERVED_AT = new Date(NOW_MS).toISOString();

function snapshot(overrides: Partial<WebhookDeliveryObservabilitySnapshot> = {}): WebhookDeliveryObservabilitySnapshot {
  return {
    observedAt: OBSERVED_AT,
    status: "HEALTHY",
    staleAfterSeconds: WEBHOOK_DELIVERY_STALE_AFTER_SECONDS,
    totalDeliveries: 4,
    nonTerminalCount: 0,
    deadLetteredCount: 0,
    staleEvidenceCount: 0,
    counts: {
      RECEIVED: 0,
      ENQUEUED: 0,
      PROCESSING: 0,
      RETRY_PENDING: 0,
      SUCCEEDED: 4,
      DEAD_LETTERED: 0,
    },
    diagnostics: [],
    diagnosticsTruncated: false,
    ...overrides,
  };
}

test("public delivery observability validator accepts internally consistent bounded evidence", () => {
  assert.equal(isWebhookDeliveryObservabilitySnapshot(snapshot()), true);

  const active = snapshot({
    status: "ACTIVE",
    totalDeliveries: 5,
    nonTerminalCount: 1,
    counts: { RECEIVED: 0, ENQUEUED: 1, PROCESSING: 0, RETRY_PENDING: 0, SUCCEEDED: 4, DEAD_LETTERED: 0 },
    diagnostics: [{
      deliveryId: "delivery-1",
      repository: "rozkalnsandris/hermes-deals",
      projectId: "hermes-deals",
      eventName: "pull_request",
      state: "ENQUEUED",
      attemptCount: 0,
      receivedAt: "2026-09-03T09:59:00.000Z",
      updatedAt: "2026-09-03T09:59:30.000Z",
      lastErrorCode: null,
      disposition: "ACTIVE",
    }],
  });
  assert.equal(isWebhookDeliveryObservabilitySnapshot(active), true);
});

test("public delivery observability validator rejects inconsistent, malformed and over-bound evidence", () => {
  assert.equal(isWebhookDeliveryObservabilitySnapshot(snapshot({ status: "HEALTHY", nonTerminalCount: 1 })), false);
  assert.equal(isWebhookDeliveryObservabilitySnapshot(snapshot({ observedAt: "not-a-time" })), false);
  assert.equal(isWebhookDeliveryObservabilitySnapshot(snapshot({ deadLetteredCount: 1 })), false);
  assert.equal(isWebhookDeliveryObservabilitySnapshot({ ...snapshot(), diagnostics: Array(WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT + 1).fill({}) }), false);
  assert.equal(isWebhookDeliveryObservabilitySnapshot({ ...snapshot(), counts: { ...snapshot().counts, UNKNOWN: 1 } }), false);
});

test("delivery observation freshness is fail-closed at exact age and clock-skew boundaries", () => {
  const at = (deltaMs: number) => new Date(NOW_MS + deltaMs).toISOString();
  assert.equal(classifyWebhookDeliveryObservation(at(-MAX_DASHBOARD_SNAPSHOT_AGE_MS + 1), NOW_MS), "FRESH");
  assert.equal(classifyWebhookDeliveryObservation(at(-MAX_DASHBOARD_SNAPSHOT_AGE_MS), NOW_MS), "FRESH");
  assert.equal(classifyWebhookDeliveryObservation(at(-MAX_DASHBOARD_SNAPSHOT_AGE_MS - 1), NOW_MS), "STALE");
  assert.equal(classifyWebhookDeliveryObservation(at(MAX_DASHBOARD_CLOCK_SKEW_MS), NOW_MS), "FRESH");
  assert.equal(classifyWebhookDeliveryObservation(at(MAX_DASHBOARD_CLOCK_SKEW_MS + 1), NOW_MS), "FUTURE");
  assert.equal(classifyWebhookDeliveryObservation("invalid", NOW_MS), "INVALID");
});
