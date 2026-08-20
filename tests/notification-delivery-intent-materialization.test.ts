import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  materializeNotificationDeliveryIntents,
  NOTIFICATION_DELIVERY_INTENT_MAX_TARGETS,
  NotificationDeliveryIntentMaterializationError,
} from "../src/shared/notification-delivery-intent-materialization.js";
import type {
  NotificationDeliveryIntent,
  NotificationDeliveryIntentEnqueueResult,
  NotificationDeliveryIntentStore,
} from "../src/shared/notification-delivery-intent-store.js";
import { notificationDeliveryEnvelope } from "../src/shared/notification-delivery.js";
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

const QUEUED_AT = "2026-08-20T05:20:00.000Z";

class FakeIntentStore implements NotificationDeliveryIntentStore {
  readonly calls: NotificationDeliveryIntent[] = [];
  readonly #outcomes: Array<NotificationDeliveryIntentEnqueueResult | Error>;

  constructor(outcomes: readonly (NotificationDeliveryIntentEnqueueResult | Error)[] = []) {
    this.#outcomes = [...outcomes];
  }

  async enqueue(
    intent: NotificationDeliveryIntent,
  ): Promise<NotificationDeliveryIntentEnqueueResult> {
    this.calls.push(intent);
    const outcome = this.#outcomes.shift() ?? { kind: "ENQUEUED" };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

test("explicit multi-target materialization preserves caller order and deterministic identities", async () => {
  const store = new FakeIntentStore();
  const targetKeys = ["primary", "backup", "mobile"] as const;

  const result = await materializeNotificationDeliveryIntents(
    { candidate, queuedAt: "2026-08-20T05:20:00Z", targetKeys },
    store,
  );

  const expectedEnvelopes = targetKeys.map((targetKey) =>
    notificationDeliveryEnvelope(candidate, targetKey),
  );
  assert.deepEqual(
    store.calls,
    expectedEnvelopes.map((envelope) => ({ envelope, queuedAt: QUEUED_AT })),
  );
  assert.deepEqual(
    result,
    {
      intents: expectedEnvelopes.map((envelope) => ({
        targetKey: envelope.targetKey,
        deliveryId: envelope.deliveryId,
        result: "ENQUEUED",
      })),
      enqueued: 3,
      duplicates: 0,
    },
  );
  assert.equal(new Set(result.intents.map((intent) => intent.deliveryId)).size, 3);
});

test("exact duplicate enqueue results remain safe bounded evidence", async () => {
  const store = new FakeIntentStore([
    { kind: "DUPLICATE" },
    { kind: "ENQUEUED" },
    { kind: "DUPLICATE" },
  ]);

  const result = await materializeNotificationDeliveryIntents(
    {
      candidate,
      queuedAt: QUEUED_AT,
      targetKeys: ["primary", "backup", "mobile"],
    },
    store,
  );

  assert.deepEqual(result.intents.map((intent) => intent.result), [
    "DUPLICATE",
    "ENQUEUED",
    "DUPLICATE",
  ]);
  assert.equal(result.enqueued, 1);
  assert.equal(result.duplicates, 2);
  for (const intent of result.intents) {
    assert.deepEqual(Object.keys(intent).sort(), ["deliveryId", "result", "targetKey"]);
  }
});

test("the entire input batch is validated before the first durable enqueue", async () => {
  const invalidInputs = [
    {
      input: { candidate, queuedAt: QUEUED_AT, targetKeys: [] },
      errorCode: "INVALID_TARGET_SET",
    },
    {
      input: { candidate, queuedAt: QUEUED_AT, targetKeys: ["primary", "primary"] },
      errorCode: "INVALID_TARGET_SET",
    },
    {
      input: {
        candidate,
        queuedAt: QUEUED_AT,
        targetKeys: Array.from(
          { length: NOTIFICATION_DELIVERY_INTENT_MAX_TARGETS + 1 },
          (_, index) => `target-${index}`,
        ),
      },
      errorCode: "INVALID_TARGET_SET",
    },
    {
      input: {
        candidate,
        queuedAt: "2026-08-20T07:20:00+02:00",
        targetKeys: ["primary"],
      },
      errorCode: "INVALID_QUEUED_AT",
    },
  ] as const;

  for (const { input, errorCode } of invalidInputs) {
    const store = new FakeIntentStore();
    await assert.rejects(
      () => materializeNotificationDeliveryIntents(input, store),
      (error: unknown) =>
        error instanceof NotificationDeliveryIntentMaterializationError &&
        error.code === errorCode,
    );
    assert.equal(store.calls.length, 0);
  }

  for (const input of [
    {
      candidate,
      queuedAt: QUEUED_AT,
      targetKeys: ["primary", "invalid target"],
    },
    {
      candidate: { ...candidate, title: "unsafe\nnotification" } as NotificationCandidate,
      queuedAt: QUEUED_AT,
      targetKeys: ["primary"],
    },
  ]) {
    const store = new FakeIntentStore();
    await assert.rejects(() => materializeNotificationDeliveryIntents(input, store));
    assert.equal(store.calls.length, 0);
  }
});

test("sequential failure preserves earlier durable calls and never reaches later targets", async () => {
  const failure = new Error("durable enqueue unavailable");
  const store = new FakeIntentStore([{ kind: "ENQUEUED" }, failure, { kind: "ENQUEUED" }]);

  await assert.rejects(
    () =>
      materializeNotificationDeliveryIntents(
        {
          candidate,
          queuedAt: QUEUED_AT,
          targetKeys: ["primary", "backup", "mobile"],
        },
        store,
      ),
    failure,
  );

  assert.equal(store.calls.length, 2);
  assert.deepEqual(
    store.calls.map((intent) => intent.envelope.targetKey),
    ["primary", "backup"],
  );
});

test("unexpected store evidence fails closed after the exact attempted enqueue", async () => {
  const store: NotificationDeliveryIntentStore = {
    enqueue: async () => ({ kind: "UNKNOWN" }) as unknown as NotificationDeliveryIntentEnqueueResult,
  };

  await assert.rejects(
    () =>
      materializeNotificationDeliveryIntents(
        { candidate, queuedAt: QUEUED_AT, targetKeys: ["primary"] },
        store,
      ),
    (error: unknown) =>
      error instanceof NotificationDeliveryIntentMaterializationError &&
      error.code === "INVALID_STORE_RESULT",
  );
});

test("delivery-intent materialization remains detached from Worker and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /notification-delivery-intent-materialization|materializeNotificationDeliveryIntents/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
