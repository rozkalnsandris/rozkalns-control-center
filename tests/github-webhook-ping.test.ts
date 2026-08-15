import assert from "node:assert/strict";
import test from "node:test";

import { handleGitHubWebhookRequest } from "../src/worker/github-webhook-route.js";

const encoder = new TextEncoder();

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `sha256=${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function webhookRequest(payload: string, signature: string, eventName: string): Request {
  return new Request("https://control.rozkalns.net/api/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-155",
      "x-github-event": eventName,
      "x-hub-signature-256": signature,
    },
    body: payload,
  });
}

test("HMAC-valid GitHub App ping succeeds without repository identity or durability write", async () => {
  const secret = "test-only-webhook-secret";
  const payload = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 155 });
  const signature = await sign(payload, secret);
  let acceptCalls = 0;

  const response = await handleGitHubWebhookRequest(
    webhookRequest(payload, signature, "ping"),
    "2026-08-15T12:40:00.000Z",
    {
      secret,
      acceptor: {
        async accept() {
          acceptCalls += 1;
          return "ACCEPTED";
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "PING" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(acceptCalls, 0);
});

test("GitHub App ping with an invalid HMAC is rejected before durability work", async () => {
  const payload = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 155 });
  let acceptCalls = 0;

  const response = await handleGitHubWebhookRequest(
    webhookRequest(payload, `sha256=${"0".repeat(64)}`, "ping"),
    "2026-08-15T12:40:00.000Z",
    {
      secret: "test-only-webhook-secret",
      acceptor: {
        async accept() {
          acceptCalls += 1;
          return "ACCEPTED";
        },
      },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "WEBHOOK_REJECTED" });
  assert.equal(acceptCalls, 0);
});

test("normal repository webhook still reaches the durability acceptor after HMAC verification", async () => {
  const secret = "test-only-webhook-secret";
  const payload = JSON.stringify({
    repository: { full_name: "rozkalnsandris/hermes-deals" },
    action: "opened",
  });
  const signature = await sign(payload, secret);
  const accepted: Array<{ repository: string; eventName: string; action: string | null }> = [];

  const response = await handleGitHubWebhookRequest(
    webhookRequest(payload, signature, "pull_request"),
    "2026-08-15T12:40:00.000Z",
    {
      secret,
      acceptor: {
        async accept(webhook) {
          accepted.push({
            repository: webhook.repository,
            eventName: webhook.eventName,
            action: webhook.action,
          });
          return "ACCEPTED";
        },
      },
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "ACCEPTED" });
  assert.deepEqual(accepted, [
    {
      repository: "rozkalnsandris/hermes-deals",
      eventName: "pull_request",
      action: "opened",
    },
  ]);
});

test("verified non-terminal CI actions are filtered before durability", async () => {
  const secret = "test-only-webhook-secret";
  const cases = [
    { eventName: "check_run", action: "created" },
    { eventName: "workflow_run", action: "requested" },
    { eventName: "workflow_run", action: "in_progress" },
  ] as const;

  for (const { eventName, action } of cases) {
    const payload = JSON.stringify({
      repository: { full_name: "rozkalnsandris/hermes-deals" },
      action,
    });
    const signature = await sign(payload, secret);
    let acceptCalls = 0;

    const response = await handleGitHubWebhookRequest(
      webhookRequest(payload, signature, eventName),
      "2026-08-15T12:40:00.000Z",
      {
        secret,
        acceptor: {
          async accept() {
            acceptCalls += 1;
            return "ACCEPTED";
          },
        },
      },
    );

    assert.equal(response.status, 202, `${eventName}.${action}`);
    assert.deepEqual(await response.json(), { status: "FILTERED" }, `${eventName}.${action}`);
    assert.equal(acceptCalls, 0, `${eventName}.${action}`);
  }
});

test("terminal CI actions still reach durability with verified action metadata", async () => {
  const secret = "test-only-webhook-secret";

  for (const eventName of ["check_run", "workflow_run"] as const) {
    const payload = JSON.stringify({
      repository: { full_name: "rozkalnsandris/hermes-deals" },
      action: "completed",
    });
    const signature = await sign(payload, secret);
    const accepted: Array<{ eventName: string; action: string | null }> = [];

    const response = await handleGitHubWebhookRequest(
      webhookRequest(payload, signature, eventName),
      "2026-08-15T12:40:00.000Z",
      {
        secret,
        acceptor: {
          async accept(webhook) {
            accepted.push({ eventName: webhook.eventName, action: webhook.action });
            return "ACCEPTED";
          },
        },
      },
    );

    assert.equal(response.status, 202, eventName);
    assert.deepEqual(await response.json(), { status: "ACCEPTED" }, eventName);
    assert.deepEqual(accepted, [{ eventName, action: "completed" }], eventName);
  }
});

test("unknown or missing CI actions fail open to the durability path rather than being silently filtered", async () => {
  const secret = "test-only-webhook-secret";
  const cases: Array<{ action?: string; expected: string | null }> = [
    { action: "future_action", expected: "future_action" },
    { expected: null },
  ];

  for (const candidate of cases) {
    const payloadObject: Record<string, unknown> = {
      repository: { full_name: "rozkalnsandris/hermes-deals" },
    };
    if (candidate.action !== undefined) payloadObject.action = candidate.action;
    const payload = JSON.stringify(payloadObject);
    const signature = await sign(payload, secret);
    const acceptedActions: Array<string | null> = [];

    const response = await handleGitHubWebhookRequest(
      webhookRequest(payload, signature, "workflow_run"),
      "2026-08-15T12:40:00.000Z",
      {
        secret,
        acceptor: {
          async accept(webhook) {
            acceptedActions.push(webhook.action);
            return "ACCEPTED";
          },
        },
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "ACCEPTED" });
    assert.deepEqual(acceptedActions, [candidate.expected]);
  }
});

test("filtered-looking webhook with invalid HMAC is rejected before the filtering shortcut", async () => {
  const payload = JSON.stringify({
    repository: { full_name: "rozkalnsandris/hermes-deals" },
    action: "created",
  });
  let acceptCalls = 0;

  const response = await handleGitHubWebhookRequest(
    webhookRequest(payload, `sha256=${"0".repeat(64)}`, "check_run"),
    "2026-08-15T12:40:00.000Z",
    {
      secret: "test-only-webhook-secret",
      acceptor: {
        async accept() {
          acceptCalls += 1;
          return "ACCEPTED";
        },
      },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "WEBHOOK_REJECTED" });
  assert.equal(acceptCalls, 0);
});

test("filtered-looking webhook from an unmanaged repository is rejected before the filtering shortcut", async () => {
  const secret = "test-only-webhook-secret";
  const payload = JSON.stringify({
    repository: { full_name: "rozkalnsandris/rozkalns-control-center" },
    action: "created",
  });
  const signature = await sign(payload, secret);
  let acceptCalls = 0;

  const response = await handleGitHubWebhookRequest(
    webhookRequest(payload, signature, "check_run"),
    "2026-08-15T12:40:00.000Z",
    {
      secret,
      acceptor: {
        async accept() {
          acceptCalls += 1;
          return "ACCEPTED";
        },
      },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "WEBHOOK_REJECTED" });
  assert.equal(acceptCalls, 0);
});

test("malformed verified action is rejected instead of accidentally matching a filter", async () => {
  const secret = "test-only-webhook-secret";
  const payload = JSON.stringify({
    repository: { full_name: "rozkalnsandris/hermes-deals" },
    action: { unexpected: true },
  });
  const signature = await sign(payload, secret);
  let acceptCalls = 0;

  const response = await handleGitHubWebhookRequest(
    webhookRequest(payload, signature, "check_run"),
    "2026-08-15T12:40:00.000Z",
    {
      secret,
      acceptor: {
        async accept() {
          acceptCalls += 1;
          return "ACCEPTED";
        },
      },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "WEBHOOK_REJECTED" });
  assert.equal(acceptCalls, 0);
});
