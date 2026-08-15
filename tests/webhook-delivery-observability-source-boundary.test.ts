import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("webhook observability is wired only through the dormant runtime assembly", async () => {
  const [reader, route, runtimeAssembly, worker, wrangler] = await Promise.all([
    readFile("src/integrations/cloudflare/d1-delivery-observability-reader.ts", "utf8"),
    readFile("src/worker/github-webhook-observability-route.ts", "utf8"),
    readFile("src/integrations/cloudflare/control-webhook-queue-runtime.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);

  assert.match(reader, /FROM webhook_deliveries/);
  assert.match(reader, /GROUP BY state/);
  assert.match(reader, /LIMIT \?1/);
  assert.match(reader, /WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT = 50/);
  assert.doesNotMatch(reader, /payload_body|raw_payload|private_key|CLOUDFLARE_API_TOKEN/i);

  assert.match(route, /WEBHOOK_OBSERVABILITY_DISABLED/);
  assert.match(route, /Cache-Control/);
  assert.doesNotMatch(route, /\benv\./);

  assert.match(runtimeAssembly, /D1WebhookDeliveryObservabilityReader/);
  assert.match(runtimeAssembly, /CONTROL_WEBHOOK_RUNTIME_ENABLED/);
  assert.match(worker, /handleGitHubWebhookObservabilityRequest/);
  assert.match(worker, /resolution\.status === "READY" \? resolution\.runtime\.observabilityReader : null/);

  assert.doesNotMatch(wrangler, /"queues"/);
  assert.doesNotMatch(
    wrangler,
    /dead_letter_queue|max_retries|GITHUB_WEBHOOK_SECRET|CONTROL_WEBHOOK_RUNTIME_ENABLED|RECONCILIATION_QUEUE/,
  );
});
