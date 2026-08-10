import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertDeliveryTransition,
  isTerminalDeliveryState,
  nextDeliveryState,
  type DurableDeliveryState,
} from "../src/shared/reconciliation-durability.js";
import {
  createReconciliationQueueMessage,
  parseReconciliationQueueMessage,
} from "../src/shared/reconciliation-queue.js";
import type { GitHubReconciliationTrigger } from "../src/shared/github-reconciliation.js";

const RECEIVED_AT = "2026-08-11T00:15:00.000Z";

function trigger(overrides: Partial<GitHubReconciliationTrigger> = {}): GitHubReconciliationTrigger {
  return {
    deliveryId: "delivery-123",
    eventName: "pull_request",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    receivedAt: RECEIVED_AT,
    authoritativeReadRequired: true,
    ...overrides,
  };
}

function durableDelivery(overrides: Partial<DurableDeliveryState> = {}): DurableDeliveryState {
  return {
    deliveryId: "delivery-123",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    eventName: "pull_request",
    messageVersion: 1,
    state: "RECEIVED",
    attemptCount: 0,
    receivedAt: RECEIVED_AT,
    updatedAt: RECEIVED_AT,
    completedAt: null,
    deadLetteredAt: null,
    lastErrorCode: null,
    ...overrides,
  };
}

test("queue messages are versioned, minimal and repository-policy bound", () => {
  const message = createReconciliationQueueMessage(trigger());

  assert.deepEqual(message, {
    schemaVersion: 1,
    kind: "GITHUB_RECONCILIATION",
    deliveryId: "delivery-123",
    eventName: "pull_request",
    repository: "rozkalnsandris/hermes-deals",
    projectId: "hermes-deals",
    receivedAt: RECEIVED_AT,
    authoritativeReadRequired: true,
  });
  assert.deepEqual(parseReconciliationQueueMessage(message), message);

  assert.throws(
    () => createReconciliationQueueMessage(trigger({ projectId: "hermes-tech" })),
    /project does not match repository policy/,
  );
  assert.throws(
    () => createReconciliationQueueMessage(trigger({ repository: "someone/unknown" })),
    /not enabled for Rozkalns Control reads/,
  );
});

test("queue parser fails closed on unknown versions, fields and non-authoritative messages", () => {
  const valid = createReconciliationQueueMessage(trigger());

  assert.throws(
    () => parseReconciliationQueueMessage({ ...valid, schemaVersion: 2 }),
    /Unsupported reconciliation queue message schema version/,
  );
  assert.throws(
    () => parseReconciliationQueueMessage({ ...valid, token: "must-not-travel" }),
    /Unsupported reconciliation queue message field: token/,
  );
  assert.throws(
    () => parseReconciliationQueueMessage({ ...valid, authoritativeReadRequired: false }),
    /must require an authoritative GitHub reread/,
  );
  assert.throws(
    () => parseReconciliationQueueMessage({ ...valid, receivedAt: "tomorrow" }),
    /UTC ISO timestamp/,
  );
});

test("delivery lifecycle permits only explicit retry-safe transitions", () => {
  assert.doesNotThrow(() => assertDeliveryTransition("RECEIVED", "ENQUEUED"));
  assert.throws(() => assertDeliveryTransition("RECEIVED", "SUCCEEDED"), /Invalid webhook delivery lifecycle transition/);
  assert.equal(isTerminalDeliveryState("SUCCEEDED"), true);
  assert.equal(isTerminalDeliveryState("DEAD_LETTERED"), true);
  assert.equal(isTerminalDeliveryState("PROCESSING"), false);

  const enqueued = nextDeliveryState(durableDelivery(), "ENQUEUED", "2026-08-11T00:15:01.000Z");
  const processing = nextDeliveryState(enqueued, "PROCESSING", "2026-08-11T00:15:02.000Z");
  assert.equal(processing.attemptCount, 1);

  assert.throws(
    () => nextDeliveryState(processing, "RETRY_PENDING", "2026-08-11T00:15:03.000Z"),
    /requires a stable non-secret error code/,
  );

  const retry = nextDeliveryState(processing, "RETRY_PENDING", "2026-08-11T00:15:03.000Z", {
    errorCode: "GITHUB_TEMPORARY_FAILURE",
  });
  const secondAttempt = nextDeliveryState(retry, "PROCESSING", "2026-08-11T00:15:04.000Z");
  assert.equal(secondAttempt.attemptCount, 2);

  const succeeded = nextDeliveryState(secondAttempt, "SUCCEEDED", "2026-08-11T00:15:05.000Z");
  assert.equal(succeeded.completedAt, "2026-08-11T00:15:05.000Z");
  assert.equal(succeeded.lastErrorCode, null);
  assert.throws(
    () => nextDeliveryState(succeeded, "PROCESSING", "2026-08-11T00:15:06.000Z"),
    /Invalid webhook delivery lifecycle transition/,
  );
});

test("dead-letter state requires durable sanitized failure evidence", () => {
  const processing = durableDelivery({ state: "PROCESSING", attemptCount: 3 });

  assert.throws(
    () => nextDeliveryState(processing, "DEAD_LETTERED", "2026-08-11T00:16:00.000Z"),
    /requires a stable non-secret error code/,
  );

  const dead = nextDeliveryState(processing, "DEAD_LETTERED", "2026-08-11T00:16:00.000Z", {
    errorCode: "RETRY_EXHAUSTED",
  });
  assert.equal(dead.deadLetteredAt, "2026-08-11T00:16:00.000Z");
  assert.equal(dead.lastErrorCode, "RETRY_EXHAUSTED");
  assert.equal(isTerminalDeliveryState(dead.state), true);
});

test("initial D1 migration encodes durable idempotency without credential or payload columns", async () => {
  const sql = await readFile("migrations/0001_reconciliation_core.sql", "utf8");

  assert.match(sql, /CREATE TABLE webhook_deliveries/);
  assert.match(sql, /delivery_id TEXT PRIMARY KEY NOT NULL/);
  assert.match(sql, /message_version INTEGER NOT NULL DEFAULT 1 CHECK \(message_version = 1\)/);
  assert.match(sql, /state IN \(/);
  assert.match(sql, /'DEAD_LETTERED'/);
  assert.match(sql, /attempt_count INTEGER NOT NULL DEFAULT 0 CHECK \(attempt_count >= 0\)/);
  assert.match(sql, /last_error_code TEXT/);
  assert.match(sql, /idx_webhook_deliveries_state_updated_at/);

  assert.doesNotMatch(sql, /^\s*(?:token|secret|private_key|webhook_payload|payload_body)\s+/im);
  assert.doesNotMatch(sql, /BLOB\s+NOT\s+NULL/i);
});
