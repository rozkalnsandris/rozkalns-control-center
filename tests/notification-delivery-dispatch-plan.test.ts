import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { NotificationDeliveryAttemptStore } from "../src/shared/notification-delivery-attempt-store.js";
import {
  NotificationDeliveryAttemptContractError,
  appendNotificationDeliveryAttempt,
  notificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptHistory,
  type NotificationDeliveryAttemptRecord,
} from "../src/shared/notification-delivery-attempt.js";
import {
  NotificationDeliveryDispatchPlanError,
  planNotificationDeliveryDispatch,
  type NotificationDeliveryDispatchPlanDependencies,
} from "../src/shared/notification-delivery-dispatch-plan.js";
import type {
  NotificationDeliveryIntentRecoveryEvidence,
  NotificationDeliveryIntentRecoveryReader,
} from "../src/shared/notification-delivery-intent-store.js";
import {
  NotificationDeliveryRetryPolicyError,
  type NotificationDeliveryRetryPolicy,
} from "../src/shared/notification-delivery-retry-policy.js";
import {
  notificationDeliveryEnvelope,
  type NotificationDeliveryEnvelope,
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
const DELIVERY_ID = envelope.deliveryId;
const QUEUED_AT = "2026-08-20T05:20:00.000Z";
const POLICY: NotificationDeliveryRetryPolicy = {
  schemaVersion: 1,
  maxAttempts: 3,
  retryDelaysSeconds: [60, 300],
};

class FakeIntentReader implements NotificationDeliveryIntentRecoveryReader {
  readonly calls: string[] = [];
  readonly #evidence: NotificationDeliveryIntentRecoveryEvidence;

  constructor(evidence: NotificationDeliveryIntentRecoveryEvidence) {
    this.#evidence = evidence;
  }

  async read(deliveryId: string): Promise<NotificationDeliveryIntentRecoveryEvidence> {
    this.calls.push(deliveryId);
    return this.#evidence;
  }
}

class FakeHistoryReader implements Pick<NotificationDeliveryAttemptStore, "readHistory"> {
  readonly calls: string[] = [];
  readonly #history: NotificationDeliveryAttemptHistory;

  constructor(history: NotificationDeliveryAttemptHistory) {
    this.#history = history;
  }

  async readHistory(deliveryId: string): Promise<NotificationDeliveryAttemptHistory> {
    this.calls.push(deliveryId);
    return this.#history;
  }
}

function foundIntent(
  envelopeValue: NotificationDeliveryEnvelope = envelope,
  queuedAt: string = QUEUED_AT,
): NotificationDeliveryIntentRecoveryEvidence {
  return {
    kind: "FOUND",
    intent: {
      envelope: envelopeValue,
      queuedAt,
    },
  };
}

function dependencies(
  evidence: NotificationDeliveryIntentRecoveryEvidence,
  history: NotificationDeliveryAttemptHistory = notificationDeliveryAttemptHistory(DELIVERY_ID),
): {
  readonly value: NotificationDeliveryDispatchPlanDependencies;
  readonly intentReader: FakeIntentReader;
  readonly historyReader: FakeHistoryReader;
} {
  const intentReader = new FakeIntentReader(evidence);
  const historyReader = new FakeHistoryReader(history);
  return {
    value: { intentReader, attemptHistoryReader: historyReader },
    intentReader,
    historyReader,
  };
}

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

test("NOT_FOUND is read-only evidence and never reads attempt history", async () => {
  const deps = dependencies({ kind: "NOT_FOUND" });

  assert.deepEqual(
    await planNotificationDeliveryDispatch(DELIVERY_ID, QUEUED_AT, POLICY, deps.value),
    { kind: "NOT_FOUND" },
  );
  assert.deepEqual(deps.intentReader.calls, [DELIVERY_ID]);
  assert.deepEqual(deps.historyReader.calls, []);
});

test("fresh durable intent becomes READY only from exact recovered evidence", async () => {
  const deps = dependencies(foundIntent());

  assert.deepEqual(
    await planNotificationDeliveryDispatch(DELIVERY_ID, QUEUED_AT, POLICY, deps.value),
    {
      kind: "FOUND",
      envelope,
      queuedAt: QUEUED_AT,
      decision: {
        kind: "READY",
        attemptNumber: 1,
        eligibleAt: QUEUED_AT,
      },
    },
  );
  assert.deepEqual(deps.intentReader.calls, [DELIVERY_ID]);
  assert.deepEqual(deps.historyReader.calls, [DELIVERY_ID]);
});

test("retry planning preserves WAIT and READY boundaries from durable history", async () => {
  const history = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, QUEUED_AT, {
      kind: "RETRYABLE_FAILURE",
      reason: "TRANSIENT_UPSTREAM",
    }),
  );

  const waiting = dependencies(foundIntent(), history);
  const waitingResult = await planNotificationDeliveryDispatch(
    DELIVERY_ID,
    "2026-08-20T05:20:59.999Z",
    POLICY,
    waiting.value,
  );
  assert.deepEqual(waitingResult.kind === "FOUND" ? waitingResult.decision : waitingResult, {
    kind: "WAIT",
    attemptNumber: 2,
    eligibleAt: "2026-08-20T05:21:00.000Z",
  });

  const ready = dependencies(foundIntent(), history);
  const readyResult = await planNotificationDeliveryDispatch(
    DELIVERY_ID,
    "2026-08-20T05:21:00.000Z",
    POLICY,
    ready.value,
  );
  assert.deepEqual(readyResult.kind === "FOUND" ? readyResult.decision : readyResult, {
    kind: "READY",
    attemptNumber: 2,
    eligibleAt: "2026-08-20T05:21:00.000Z",
  });
});

test("final and exhausted histories remain no-send planning states", async () => {
  const delivered = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, QUEUED_AT, { kind: "DELIVERED" }),
  );
  const deliveredDeps = dependencies(foundIntent(), delivered);
  const deliveredResult = await planNotificationDeliveryDispatch(
    DELIVERY_ID,
    "2026-08-21T05:20:00.000Z",
    POLICY,
    deliveredDeps.value,
  );
  assert.deepEqual(
    deliveredResult.kind === "FOUND" ? deliveredResult.decision : deliveredResult,
    { kind: "DELIVERED" },
  );

  const terminal = appendNotificationDeliveryAttempt(
    notificationDeliveryAttemptHistory(DELIVERY_ID),
    attempt(1, QUEUED_AT, {
      kind: "TERMINAL_FAILURE",
      reason: "DESTINATION_INVALID",
    }),
  );
  const terminalDeps = dependencies(foundIntent(), terminal);
  const terminalResult = await planNotificationDeliveryDispatch(
    DELIVERY_ID,
    "2026-08-21T05:20:00.000Z",
    POLICY,
    terminalDeps.value,
  );
  assert.deepEqual(
    terminalResult.kind === "FOUND" ? terminalResult.decision : terminalResult,
    { kind: "TERMINAL_FAILURE" },
  );

  let exhausted = notificationDeliveryAttemptHistory(DELIVERY_ID);
  exhausted = appendNotificationDeliveryAttempt(
    exhausted,
    attempt(1, QUEUED_AT, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }),
  );
  exhausted = appendNotificationDeliveryAttempt(
    exhausted,
    attempt(2, "2026-08-20T05:21:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "PROVIDER_UNAVAILABLE",
    }),
  );
  exhausted = appendNotificationDeliveryAttempt(
    exhausted,
    attempt(3, "2026-08-20T05:26:00.000Z", {
      kind: "RETRYABLE_FAILURE",
      reason: "TRANSIENT_UPSTREAM",
    }),
  );
  const exhaustedDeps = dependencies(foundIntent(), exhausted);
  const exhaustedResult = await planNotificationDeliveryDispatch(
    DELIVERY_ID,
    "2026-08-20T06:00:00.000Z",
    POLICY,
    exhaustedDeps.value,
  );
  assert.deepEqual(
    exhaustedResult.kind === "FOUND" ? exhaustedResult.decision : exhaustedResult,
    { kind: "EXHAUSTED", attemptCount: 3, maxAttempts: 3 },
  );
});

test("requested identity and observed time are validated before any durable read", async () => {
  for (const input of [
    { deliveryId: "not-a-delivery", observedAt: QUEUED_AT },
    { deliveryId: DELIVERY_ID, observedAt: "2026-08-20T07:20:00+02:00" },
  ]) {
    const deps = dependencies(foundIntent());
    await assert.rejects(
      () => planNotificationDeliveryDispatch(input.deliveryId, input.observedAt, POLICY, deps.value),
      (error: unknown) =>
        error instanceof NotificationDeliveryDispatchPlanError && error.code === "INVALID_INPUT",
    );
    assert.deepEqual(deps.intentReader.calls, []);
    assert.deepEqual(deps.historyReader.calls, []);
  }
});

test("recovered delivery identity or deterministic envelope drift fails before history read", async () => {
  const otherCandidate: NotificationCandidate = {
    ...candidate,
    transitionId: "notification-v1-ci-failed-fedcba9876543210",
  };
  const otherEnvelope = notificationDeliveryEnvelope(otherCandidate, "primary");
  const wrongIdentity = dependencies(foundIntent(otherEnvelope));
  await assert.rejects(
    () => planNotificationDeliveryDispatch(DELIVERY_ID, QUEUED_AT, POLICY, wrongIdentity.value),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchPlanError &&
      error.code === "INTENT_EVIDENCE_MISMATCH",
  );
  assert.deepEqual(wrongIdentity.historyReader.calls, []);

  const drifted = dependencies(
    foundIntent({ ...envelope, title: "Mutated recovered title" } as NotificationDeliveryEnvelope),
  );
  await assert.rejects(
    () => planNotificationDeliveryDispatch(DELIVERY_ID, QUEUED_AT, POLICY, drifted.value),
    (error: unknown) =>
      error instanceof NotificationDeliveryDispatchPlanError &&
      error.code === "INTENT_EVIDENCE_MISMATCH",
  );
  assert.deepEqual(drifted.historyReader.calls, []);
});

test("malformed durable history and retry policy fail closed through owning contracts", async () => {
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
  const historyDeps = dependencies(foundIntent(), malformedHistory);
  await assert.rejects(
    () => planNotificationDeliveryDispatch(DELIVERY_ID, QUEUED_AT, POLICY, historyDeps.value),
    (error: unknown) => error instanceof NotificationDeliveryAttemptContractError,
  );

  const invalidPolicy = {
    schemaVersion: 1,
    maxAttempts: 0,
    retryDelaysSeconds: [],
  } as NotificationDeliveryRetryPolicy;
  const policyDeps = dependencies(foundIntent());
  await assert.rejects(
    () => planNotificationDeliveryDispatch(DELIVERY_ID, QUEUED_AT, invalidPolicy, policyDeps.value),
    (error: unknown) => error instanceof NotificationDeliveryRetryPolicyError,
  );
});

test("read-only dispatch planner remains detached from Worker and React runtime", () => {
  const runtimeSources = [
    readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFileSync(
      resolve(process.cwd(), "src/integrations/cloudflare/control-webhook-queue-runtime.ts"),
      "utf8",
    ),
    readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8"),
  ];
  const runtimePattern =
    /notification-delivery-dispatch-plan|planNotificationDeliveryDispatch/;

  for (const source of runtimeSources) assert.doesNotMatch(source, runtimePattern);
});
