import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Queue consumer and DLQ lifecycle are exposed only through the dormant runtime gate", async () => {
  const [consumer, runtimeAssembly, worker, wrangler] = await Promise.all([
    readFile("src/integrations/cloudflare/reconciliation-queue-consumer.ts", "utf8"),
    readFile("src/integrations/cloudflare/control-webhook-queue-runtime.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);

  assert.match(consumer, /parseReconciliationQueueMessage/);
  assert.match(consumer, /await dependencies\.deliveryStore\.markProcessing/);
  assert.match(consumer, /await dependencies\.executor\.reconcile/);
  assert.match(consumer, /await dependencies\.deliveryStore\.markSucceeded/);
  assert.match(consumer, /await dependencies\.deliveryStore\.markRetryPending/);
  assert.match(consumer, /await dependencies\.deliveryStore\.markDeadLettered/);
  assert.match(consumer, /RECONCILIATION_RETRY_ERROR_CODE/);
  assert.match(consumer, /RECONCILIATION_DLQ_ERROR_CODE/);
  assert.doesNotMatch(consumer, /token=|private[_-]?key|WEBHOOK_SECRET|CLOUDFLARE_API_TOKEN/i);
  assert.doesNotMatch(consumer, /\benv\./);

  assert.match(runtimeAssembly, /finalizeReconciliationDeadLetter/);
  assert.match(runtimeAssembly, /RECONCILIATION_QUEUE_NAME/);
  assert.match(runtimeAssembly, /RECONCILIATION_DLQ_NAME/);
  assert.match(worker, /async queue\(batch, env\)/);
  assert.match(worker, /RUNTIME_UNAVAILABLE/);

  assert.doesNotMatch(wrangler, /"queues"/);
  assert.doesNotMatch(
    wrangler,
    /dead_letter_queue|max_retries|CONTROL_WEBHOOK_RUNTIME_ENABLED|RECONCILIATION_QUEUE/,
  );
});
