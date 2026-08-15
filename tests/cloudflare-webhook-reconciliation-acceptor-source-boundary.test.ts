import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("recoverable webhook Queue adapter is assembled only behind the dormant runtime gate", async () => {
  const [adapter, runtimeAssembly, worker, wrangler] = await Promise.all([
    readFile("src/integrations/cloudflare/webhook-reconciliation-acceptor.ts", "utf8"),
    readFile("src/integrations/cloudflare/control-webhook-queue-runtime.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);

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

  assert.doesNotMatch(wrangler, /"queues"/);
  assert.doesNotMatch(
    wrangler,
    /WEBHOOK_SECRET|GITHUB_WEBHOOK_SECRET|CONTROL_WEBHOOK_RUNTIME_ENABLED|RECONCILIATION_QUEUE/,
  );
});
