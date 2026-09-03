import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramNotificationDeliveryDispatchAdapter,
  TELEGRAM_SEND_MESSAGE_TEXT_LIMIT,
  TelegramNotificationDeliveryAdapterError,
  type TelegramNotificationFetch,
} from "../src/integrations/telegram/notification-delivery-dispatch-adapter.js";
import {
  notificationDeliveryDispatchAttempt,
  type NotificationDeliveryDispatchAttempt,
} from "../src/shared/notification-delivery-dispatch-attempt.js";
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

function attempt(targetKey = "primary"): NotificationDeliveryDispatchAttempt {
  return notificationDeliveryDispatchAttempt(
    notificationDeliveryEnvelope(candidate, targetKey),
    {
      kind: "READY",
      attemptNumber: 1,
      eligibleAt: "2026-09-03T15:00:00.000Z",
    },
    "2026-09-03T15:01:00.000Z",
  );
}

function config() {
  return {
    targetKey: "primary",
    botToken: "TEST_TOKEN",
    chatId: "-1001234567890",
    controlOrigin: "https://control.example.com",
  } as const;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Telegram adapter sends one bounded plain-text sendMessage request", async () => {
  const captured: Array<{
    readonly input: string;
    readonly init: RequestInit;
  }> = [];

  const fetcher: TelegramNotificationFetch = async (input, init) => {
    captured.push({ input, init });
    return jsonResponse({ ok: true, result: { message_id: 42 } });
  };

  const adapter = createTelegramNotificationDeliveryDispatchAdapter(config(), fetcher);
  assert.deepEqual(await adapter.deliver(attempt()), { kind: "DELIVERED" });
  assert.equal(captured.length, 1);

  const request = captured[0];
  assert.ok(request);
  assert.equal(request.input, "https://api.telegram.org/botTEST_TOKEN/sendMessage");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "manual");

  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("accept"), "application/json");

  const rawBody = request.init.body;
  if (typeof rawBody !== "string") throw new Error("expected JSON request body");
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["chat_id", "text"]);
  assert.equal(payload.chat_id, "-1001234567890");
  assert.equal(
    payload.text,
    [
      candidate.title,
      candidate.reference,
      "",
      candidate.body,
      "",
      `https://control.example.com${candidate.deepLinkPath}`,
    ].join("\n"),
  );
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "parse_mode"), false);
  assert.ok(Array.from(String(payload.text)).length <= TELEGRAM_SEND_MESSAGE_TEXT_LIMIT);
});

test("target mismatch fails closed before crossing the provider boundary", async () => {
  let calls = 0;
  const fetcher: TelegramNotificationFetch = async () => {
    calls += 1;
    return jsonResponse({ ok: true, result: { message_id: 42 } });
  };

  const adapter = createTelegramNotificationDeliveryDispatchAdapter(config(), fetcher);
  assert.deepEqual(await adapter.deliver(attempt("backup")), {
    kind: "TERMINAL_FAILURE",
    reason: "DESTINATION_INVALID",
  });
  assert.equal(calls, 0);
});

test("explicit HTTP failures map into canonical delivery results", async () => {
  const cases = [
    [429, { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" }],
    [408, { kind: "RETRYABLE_FAILURE", reason: "TRANSIENT_UPSTREAM" }],
    [503, { kind: "RETRYABLE_FAILURE", reason: "PROVIDER_UNAVAILABLE" }],
    [401, { kind: "TERMINAL_FAILURE", reason: "AUTHORIZATION_FAILED" }],
    [403, { kind: "TERMINAL_FAILURE", reason: "AUTHORIZATION_FAILED" }],
    [404, { kind: "TERMINAL_FAILURE", reason: "AUTHORIZATION_FAILED" }],
    [400, { kind: "TERMINAL_FAILURE", reason: "PAYLOAD_REJECTED" }],
  ] as const;

  for (const [status, expected] of cases) {
    const fetcher: TelegramNotificationFetch = async () =>
      jsonResponse({ ok: false, description: "provider detail must be ignored" }, status);
    const adapter = createTelegramNotificationDeliveryDispatchAdapter(config(), fetcher);
    assert.deepEqual(await adapter.deliver(attempt()), expected);
  }
});

test("explicit Telegram error_code in a successful HTTP response is classified without description text", async () => {
  const fetcher: TelegramNotificationFetch = async () =>
    jsonResponse({
      ok: false,
      error_code: 429,
      description: "flood control detail must not become durable evidence",
      parameters: { retry_after: 9 },
    });

  const adapter = createTelegramNotificationDeliveryDispatchAdapter(config(), fetcher);
  assert.deepEqual(await adapter.deliver(attempt()), {
    kind: "RETRYABLE_FAILURE",
    reason: "RATE_LIMITED",
  });
});

test("malformed success and network failures throw only sanitized ambiguity errors", async () => {
  const malformed = createTelegramNotificationDeliveryDispatchAdapter(
    config(),
    async () => jsonResponse({ ok: true, result: {} }),
  );

  await assert.rejects(
    () => malformed.deliver(attempt()),
    (error: unknown) =>
      error instanceof TelegramNotificationDeliveryAdapterError &&
      error.code === "AMBIGUOUS_PROVIDER_OUTCOME" &&
      !error.message.includes("TEST_TOKEN") &&
      !error.message.includes("-1001234567890"),
  );

  const network = createTelegramNotificationDeliveryDispatchAdapter(
    config(),
    async () => {
      throw new Error(
        "https://api.telegram.org/botTEST_TOKEN/sendMessage failed for -1001234567890",
      );
    },
  );

  await assert.rejects(
    () => network.deliver(attempt()),
    (error: unknown) =>
      error instanceof TelegramNotificationDeliveryAdapterError &&
      error.code === "AMBIGUOUS_PROVIDER_OUTCOME" &&
      !error.message.includes("TEST_TOKEN") &&
      !error.message.includes("-1001234567890"),
  );
});

test("invalid runtime configuration is rejected synchronously without echoing sensitive values", () => {
  assert.throws(
    () =>
      createTelegramNotificationDeliveryDispatchAdapter({
        ...config(),
        botToken: "bad/token",
      }),
    (error: unknown) =>
      error instanceof TelegramNotificationDeliveryAdapterError &&
      error.code === "INVALID_CONFIGURATION" &&
      !error.message.includes("bad/token"),
  );

  assert.throws(
    () =>
      createTelegramNotificationDeliveryDispatchAdapter({
        ...config(),
        controlOrigin: "http://control.example.com",
      }),
    (error: unknown) =>
      error instanceof TelegramNotificationDeliveryAdapterError &&
      error.code === "INVALID_CONFIGURATION",
  );
});
