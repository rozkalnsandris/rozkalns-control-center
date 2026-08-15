import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("recoverable webhook Queue adapter remains injected and live runtime stays disabled", async () => {
  const [adapter, worker, wrangler] = await Promise.all([
    readFile("src/integrations/cloudflare/webhook-reconciliation-acceptor.ts", "utf8"),
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

  assert.match(worker, /secret:\s*null/);
  assert.match(worker, /acceptor:\s*null/);
  assert.doesNotMatch(worker, /WebhookReconciliationAcceptor/);

  assert.doesNotMatch(wrangler, /"queues"/);
  assert.doesNotMatch(wrangler, /WEBHOOK_SECRET|GITHUB_WEBHOOK_SECRET/);
});
