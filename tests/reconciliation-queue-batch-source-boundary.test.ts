import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Queue batch reconciliation remains source-only and runtime-disabled", async () => {
  const [batchConsumer, batchRuntime, worker, wrangler] = await Promise.all([
    readFile("src/integrations/cloudflare/reconciliation-queue-batch-consumer.ts", "utf8"),
    readFile("src/integrations/cloudflare/cloudflare-reconciliation-batch-runtime.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);

  assert.match(batchConsumer, /Promise\.allSettled/);
  assert.match(batchConsumer, /sharedReconciliation/);
  assert.match(batchConsumer, /consumeReconciliationQueueMessage/);
  assert.match(batchRuntime, /readCloudflareGitHubDashboardSnapshot/);
  assert.doesNotMatch(batchConsumer, /payload_body|raw_payload|private_key|CLOUDFLARE_API_TOKEN/i);

  assert.match(worker, /secret:\s*null/);
  assert.match(worker, /acceptor:\s*null/);
  assert.doesNotMatch(worker, /createCloudflareReconciliationBatchHandler/);
  assert.doesNotMatch(worker, /\bqueue\s*\(/);

  assert.doesNotMatch(wrangler, /"queues"/);
  assert.doesNotMatch(wrangler, /dead_letter_queue|max_retries|GITHUB_WEBHOOK_SECRET/);
});
