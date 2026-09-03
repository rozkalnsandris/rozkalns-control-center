import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("recoverable webhook Queue adapter is exposed only through the exact fail-closed runtime gate", async () => {
  const [adapter, runtimeAssembly, worker, wranglerSource] = await Promise.all([
    readFile("src/integrations/cloudflare/webhook-reconciliation-acceptor.ts", "utf8"),
    readFile("src/integrations/cloudflare/control-webhook-queue-runtime.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);
  const wrangler = JSON.parse(wranglerSource);

  assert.match(adapter, /await this\.#queue\.send\(message\)/);
  assert.match(adapter, /await this\.#deliveryStore\.markEnqueued/);
  assert.match(adapter, /durable\.state !== "RECEIVED"/);
  assert.match(adapter, /authoritativeReadRequired: true/);
  assert.doesNotMatch(adapter, /waitUntil\(/);
  assert.doesNotMatch(adapter, /\benv\./);
  assert.doesNotMatch(adapter, /CLOUDFLARE|WEBHOOK_SECRET|api\.cloudflare\.com/);

  assert.match(runtimeAssembly, /new WebhookReconciliationAcceptor/);
  assert.match(runtimeAssembly, /CONTROL_WEBHOOK_RUNTIME_ENABLED/);
  assert.match(runtimeAssembly, /!== "true"/);
  assert.match(worker, /resolution\.runtime\.webhookSecret/);
  assert.match(worker, /resolution\.runtime\.webhookAcceptor/);
  assert.match(worker, /secret:\s*null/);
  assert.match(worker, /acceptor:\s*null/);

  assert.equal(wrangler.vars.CONTROL_WEBHOOK_RUNTIME_ENABLED, "true");
  assert.deepEqual(wrangler.secrets.required, [
    "GITHUB_APP_PRIVATE_KEY_PEM",
    "GITHUB_WEBHOOK_SECRET",
    "CONTROL_TELEGRAM_BOT_TOKEN",
    "CONTROL_TELEGRAM_CHAT_ID",
  ]);
  assert.deepEqual(wrangler.queues.producers, [
    {
      binding: "RECONCILIATION_QUEUE",
      queue: "rozkalns-control-reconciliation",
    },
    {
      binding: "NOTIFICATION_DISPATCH_QUEUE",
      queue: "rozkalns-control-notification-dispatch",
    },
  ]);
  assert.doesNotMatch(wranglerSource, /test-webhook-secret|BEGIN (?:RSA )?PRIVATE KEY|ghs_/i);
});
