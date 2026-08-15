import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Queue batch reconciliation remains coalesced under the reviewed production binding", async () => {
  const [batchConsumer, batchRuntime, runtimeAssembly, worker, wranglerSource] = await Promise.all([
    readFile("src/integrations/cloudflare/reconciliation-queue-batch-consumer.ts", "utf8"),
    readFile("src/integrations/cloudflare/cloudflare-reconciliation-batch-runtime.ts", "utf8"),
    readFile("src/integrations/cloudflare/control-webhook-queue-runtime.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);
  const wrangler = JSON.parse(wranglerSource);

  assert.match(batchConsumer, /Promise\.allSettled/);
  assert.match(batchConsumer, /sharedReconciliation/);
  assert.match(batchConsumer, /consumeReconciliationQueueMessage/);
  assert.match(batchRuntime, /readCloudflareGitHubDashboardSnapshot/);
  assert.doesNotMatch(batchConsumer, /payload_body|raw_payload|private_key|CLOUDFLARE_API_TOKEN/i);

  assert.match(runtimeAssembly, /CONTROL_WEBHOOK_RUNTIME_ENABLED/);
  assert.match(runtimeAssembly, /!== "true"/);
  assert.match(runtimeAssembly, /createCloudflareReconciliationBatchHandler/);
  assert.match(worker, /resolveControlWebhookQueueRuntime/);
  assert.match(worker, /async queue\(batch, env\)/);

  assert.equal(wrangler.vars.CONTROL_WEBHOOK_RUNTIME_ENABLED, "true");
  assert.deepEqual(wrangler.queues.producers, [
    { binding: "RECONCILIATION_QUEUE", queue: "rozkalns-control-reconciliation" },
  ]);
  assert.equal(wrangler.queues.consumers[0].max_concurrency, 1);
  assert.equal(wrangler.queues.consumers[0].max_batch_size, 10);
});
