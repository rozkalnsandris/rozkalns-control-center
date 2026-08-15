import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Queue consumer and DLQ lifecycle use the exact reviewed bounded production policy", async () => {
  const [consumer, runtimeAssembly, worker, wranglerSource] = await Promise.all([
    readFile("src/integrations/cloudflare/reconciliation-queue-consumer.ts", "utf8"),
    readFile("src/integrations/cloudflare/control-webhook-queue-runtime.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);
  const wrangler = JSON.parse(wranglerSource);

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

  assert.deepEqual(wrangler.queues.consumers, [
    {
      queue: "rozkalns-control-reconciliation",
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 3,
      retry_delay: 30,
      max_concurrency: 1,
      dead_letter_queue: "rozkalns-control-reconciliation-dlq",
    },
    {
      queue: "rozkalns-control-reconciliation-dlq",
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 3,
      max_concurrency: 1,
    },
  ]);
});
