import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("webhook delivery observability remains source-only and runtime-disabled", async () => {
  const [reader, route, worker, wrangler] = await Promise.all([
    readFile("src/integrations/cloudflare/d1-delivery-observability-reader.ts", "utf8"),
    readFile("src/worker/github-webhook-observability-route.ts", "utf8"),
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

  assert.match(worker, /secret:\s*null/);
  assert.match(worker, /acceptor:\s*null/);
  assert.doesNotMatch(worker, /handleGitHubWebhookObservabilityRequest|webhook-deliveries/);
  assert.doesNotMatch(worker, /\bqueue\s*\(/);

  assert.doesNotMatch(wrangler, /"queues"/);
  assert.doesNotMatch(wrangler, /dead_letter_queue|max_retries|GITHUB_WEBHOOK_SECRET/);
});
