import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Queue consumer and DLQ lifecycle remain source-only and runtime-disabled", async () => {
  const [consumer, worker, wrangler] = await Promise.all([
    readFile("src/integrations/cloudflare/reconciliation-queue-consumer.ts", "utf8"),
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

  assert.match(worker, /secret:\s*null/);
  assert.match(worker, /acceptor:\s*null/);
  assert.doesNotMatch(worker, /\bqueue\s*\(/);
  assert.doesNotMatch(worker, /consumeReconciliationQueueMessage|finalizeReconciliationDeadLetter/);

  assert.doesNotMatch(wrangler, /"queues"/);
  assert.doesNotMatch(wrangler, /dead_letter_queue|max_retries/);
});
