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
  notificationDeliveryDispatchId,
} from "../src/shared/notification-delivery-dispatch-attempt.js";
import type {
  NotificationDeliveryDispatchClaimRecoveryEvidence,
  NotificationDeliveryDispatchClaimRecoveryReader,
} from "../src/shared/notification-delivery-dispatch-claim-store.js";
import {
  NotificationDeliveryDispatchRecoveryError,
  recoverNotificationDeliveryDispatch,
  type NotificationDeliveryDispatchRecoveryErrorCode,
} from "../src/shared/notification-delivery-dispatch-recovery.js";
import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
  type NotificationDeliveryResult,
} from "../src/shared/notification-delivery.js";
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

class FakeAttemptStore implements NotificationDeliveryAttemptStore {
  readonly #history: NotificationDeliveryAttemptHistory | Error;
  appendCalls = 0;

  constructor(history: NotificationDeliveryAttemptHistory | Error) {
    this.#history = history;
  }

  async readHistory(deliveryId: string): Promise<NotificationDeliveryAttemptHistory> {
    if (this.#history instanceof Error) throw this.#history;
    assert.equal(deliveryId, envelope.deliveryId);
    return this.#history;
  }

  async append(): Promise<NotificationDeliveryAttemptAppendResult> {
    this.appendCalls += 1;
    throw new Error("restart-safe recovery must never append");
  }
}

class FakeClaimReader implements NotificationDeliveryDispatchClaimRecoveryReader {
  readonly #evidence: NotificationDeliveryDispatchClaimRecoveryEvidence | Error;
  calls: Array<{ deliveryId: string; attemptNumber: number }> = [];

  constructor(evidence: NotificationDeliveryDispatchClaimRecoveryEvidence | Error) {
    this.#evidence = evidence;
  }

  async readSnapshot(
    deliveryId: string,
    attemptNumber: number,
  ): Promise<NotificationDeliveryDispatchClaimRecoveryEvidence> {
    this.calls.push({ deliveryId, attemptNumber });
    if (this.#evidence instanceof Error) throw this.#evidence;
    return this.#evidence;
  }
}

function claimEvidence(
  attemptNumber: number,
  attemptedAt: string,
  overrides: Partial<{
    dispatchId: string;
    deliveryId: string;
    transitionId: string;
    targetKey: string;
    attemptedAt: string;
  }> = {},
): NotificationDeliveryDispatchClaimRecoveryEvidence {
  return {
    kind: "CLAIMED",
    claim: {
      schemaVersion: 1,
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, attemptNumber),
      deliveryId: envelope.deliveryId,
      attemptNumber,
      transitionId: envelope.transitionId,
      targetKey: envelope.targetKey,
      attemptedAt,
      ...overrides,
    },
  };
}

function record(
  attemptNumber: number,
  attemptedAt: string,
  result: NotificationDeliveryResult,
): NotificationDeliveryAttemptRecord {
  return {
    schemaVersion: 1,
    deliveryId: envelope.deliveryId,
    attemptNumber,
    attemptedAt,
    result,
  };
}

function historyWith(
  attempts: readonly NotificationDeliveryAttemptRecord[],
): NotificationDeliveryAttemptHistory {
  let history = notificationDeliveryAttemptHistory(envelope.deliveryId);
  for (const attempt of attempts) history = appendNotificationDeliveryAttempt(history, attempt);
  return history;
}

async function expectRecoveryError(
  operation: () => Promise<unknown>,
  code: NotificationDeliveryDispatchRecoveryErrorCode,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof NotificationDeliveryDispatchRecoveryError);
    assert.equal(error.code, code);
    return true;
  });
}

test("restart recovery preserves original claimed timestamp instead of inventing a resend after time advances", async () => {
  const originalAttemptedAt = "2026-08-20T08:05:00.000Z";
  const laterObservation = "2026-08-20T08:30:00.000Z";
  const laterVolatileAttempt = notificationDeliveryDispatchAttempt(
    envelope,
    { kind: "READY", attemptNumber: 1, eligibleAt: originalAttemptedAt },
    laterObservation,
  );
  assert.notEqual(laterVolatileAttempt.attemptedAt, originalAttemptedAt);

  const attemptStore = new FakeAttemptStore(notificationDeliveryAttemptHistory(envelope.deliveryId));
  const claimReader = new FakeClaimReader(claimEvidence(1, originalAttemptedAt));

  assert.deepEqual(
    await recoverNotificationDeliveryDispatch(envelope, 1, { attemptStore, claimReader }),
    {
      kind: "AMBIGUOUS_CLAIMED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
      attemptedAt: originalAttemptedAt,
    },
  );
  assert.deepEqual(claimReader.calls, [{ deliveryId: envelope.deliveryId, attemptNumber: 1 }]);
  assert.equal(attemptStore.appendCalls, 0);
});

test("no claim and no result returns NOT_STARTED evidence only", async () => {
  const attemptStore = new FakeAttemptStore(notificationDeliveryAttemptHistory(envelope.deliveryId));
  const claimReader = new FakeClaimReader({ kind: "NOT_CLAIMED" });

  assert.deepEqual(
    await recoverNotificationDeliveryDispatch(envelope, 1, { attemptStore, claimReader }),
    {
      kind: "NOT_STARTED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
    },
  );
  assert.equal(attemptStore.appendCalls, 0);
});

test("matching durable claim and attempt result recover RECORDED typed evidence", async () => {
  const attemptedAt = "2026-08-20T08:05:00.000Z";
  const result: NotificationDeliveryResult = {
    kind: "RETRYABLE_FAILURE",
    reason: "PROVIDER_UNAVAILABLE",
  };
  const attemptStore = new FakeAttemptStore(historyWith([record(1, attemptedAt, result)]));
  const claimReader = new FakeClaimReader(claimEvidence(1, attemptedAt));

  assert.deepEqual(
    await recoverNotificationDeliveryDispatch(envelope, 1, { attemptStore, claimReader }),
    {
      kind: "RECORDED",
      dispatchId: notificationDeliveryDispatchId(envelope.deliveryId, 1),
      attemptNumber: 1,
      attemptedAt,
      result,
    },
  );
});

test("durable result without the required claim fails closed", async () => {
  const attemptedAt = "2026-08-20T08:05:00.000Z";
  const attemptStore = new FakeAttemptStore(
    historyWith([record(1, attemptedAt, { kind: "DELIVERED" })]),
  );
  const claimReader = new FakeClaimReader({ kind: "NOT_CLAIMED" });

  await expectRecoveryError(
    () => recoverNotificationDeliveryDispatch(envelope, 1, { attemptStore, claimReader }),
    "UNCLAIMED_RESULT",
  );
});

test("claim/result timestamp mismatch and envelope identity drift fail closed", async () => {
  const attemptedAt = "2026-08-20T08:05:00.000Z";
  const attemptStore = new FakeAttemptStore(
    historyWith([record(1, attemptedAt, { kind: "DELIVERED" })]),
  );

  await expectRecoveryError(
    () =>
      recoverNotificationDeliveryDispatch(envelope, 1, {
        attemptStore,
        claimReader: new FakeClaimReader(claimEvidence(1, "2026-08-20T08:06:00.000Z")),
      }),
    "RESULT_EVIDENCE_MISMATCH",
  );

  const emptyStore = new FakeAttemptStore(notificationDeliveryAttemptHistory(envelope.deliveryId));
  await expectRecoveryError(
    () =>
      recoverNotificationDeliveryDispatch(envelope, 1, {
        attemptStore: emptyStore,
        claimReader: new FakeClaimReader(
          claimEvidence(1, attemptedAt, {
            transitionId: "notification-v1-needs-andris-fedcba9876543210",
          }),
        ),
      }),
    "CLAIM_EVIDENCE_MISMATCH",
  );
});

test("stale or skipped recovery attempt and claim chronology drift fail closed", async () => {
  const retryHistory = historyWith([
    record(1, "2026-08-20T08:10:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "RATE_LIMITED",
    }),
  ]);

  await expectRecoveryError(
    () =>
      recoverNotificationDeliveryDispatch(envelope, 3, {
        attemptStore: new FakeAttemptStore(retryHistory),
        claimReader: new FakeClaimReader({ kind: "NOT_CLAIMED" }),
      }),
    "ATTEMPT_STATE_MISMATCH",
  );

  await expectRecoveryError(
    () =>
      recoverNotificationDeliveryDispatch(envelope, 2, {
        attemptStore: new FakeAttemptStore(retryHistory),
        claimReader: new FakeClaimReader(claimEvidence(2, "2026-08-20T08:09:59.999Z")),
      }),
    "ATTEMPT_STATE_MISMATCH",
  );

  const finalHistory = historyWith([
    record(1, "2026-08-20T08:10:00.000Z", { kind: "DELIVERED" }),
  ]);
  await expectRecoveryError(
    () =>
      recoverNotificationDeliveryDispatch(envelope, 2, {
        attemptStore: new FakeAttemptStore(finalHistory),
        claimReader: new FakeClaimReader({ kind: "NOT_CLAIMED" }),
      }),
    "ATTEMPT_STATE_MISMATCH",
  );
});

test("unconfirmed attempt or claim reads fail closed", async () => {
  await expectRecoveryError(
    () =>
      recoverNotificationDeliveryDispatch(envelope, 1, {
        attemptStore: new FakeAttemptStore(new Error("D1 unavailable")),
        claimReader: new FakeClaimReader({ kind: "NOT_CLAIMED" }),
      }),
    "ATTEMPT_EVIDENCE_UNCONFIRMED",
  );

  await expectRecoveryError(
    () =>
      recoverNotificationDeliveryDispatch(envelope, 1, {
        attemptStore: new FakeAttemptStore(notificationDeliveryAttemptHistory(envelope.deliveryId)),
        claimReader: new FakeClaimReader(new Error("D1 unavailable")),
      }),
    "CLAIM_EVIDENCE_UNCONFIRMED",
  );
});

test("malformed recovery request fails before durable reads", async () => {
  const driftedEnvelope = {
    ...envelope,
    deliveryId: "delivery-v1-ffffffffffffffff",
  } as NotificationDeliveryEnvelope;
  const attemptStore = new FakeAttemptStore(notificationDeliveryAttemptHistory(envelope.deliveryId));
  const claimReader = new FakeClaimReader({ kind: "NOT_CLAIMED" });

  await expectRecoveryError(
    () => recoverNotificationDeliveryDispatch(driftedEnvelope, 1, { attemptStore, claimReader }),
    "INVALID_REQUEST",
  );
  assert.deepEqual(claimReader.calls, []);
});

test("restart-safe recovery remains detached from Worker, Queue and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /notification-delivery-dispatch-recovery|recoverNotificationDeliveryDispatch|readSnapshot\(/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
