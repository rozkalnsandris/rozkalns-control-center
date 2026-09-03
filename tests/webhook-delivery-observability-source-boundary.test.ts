import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("webhook observability stays bounded and no-store under the reviewed activation config", async () => {
  const [reader, sharedContract, route, runtimeAssembly, worker, wranglerSource] = await Promise.all([
    readFile("src/integrations/cloudflare/d1-delivery-observability-reader.ts", "utf8"),
    readFile("src/shared/webhook-delivery-observability.ts", "utf8"),
    readFile("src/worker/github-webhook-observability-route.ts", "utf8"),
    readFile("src/integrations/cloudflare/control-webhook-queue-runtime.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);
  const wrangler = JSON.parse(wranglerSource);

  assert.match(reader, /FROM webhook_deliveries/);
  assert.match(reader, /GROUP BY state/);
  assert.match(reader, /LIMIT \?1/);
  assert.match(sharedContract, /WEBHOOK_DELIVERY_DIAGNOSTIC_LIMIT = 50/);
  assert.doesNotMatch(reader, /payload_body|raw_payload|private_key|CLOUDFLARE_API_TOKEN/i);

  assert.match(route, /WEBHOOK_OBSERVABILITY_DISABLED/);
  assert.match(route, /Cache-Control/);
  assert.doesNotMatch(route, /\benv\./);

  assert.match(runtimeAssembly, /D1WebhookDeliveryObservabilityReader/);
  assert.match(runtimeAssembly, /CONTROL_WEBHOOK_RUNTIME_ENABLED/);
  assert.match(worker, /handleGitHubWebhookObservabilityRequest/);
  assert.match(worker, /resolution\.status === "READY" \? resolution\.runtime\.observabilityReader : null/);

  assert.equal(wrangler.vars.CONTROL_WEBHOOK_RUNTIME_ENABLED, "true");
  assert.equal(wrangler.queues.consumers[0].dead_letter_queue, "rozkalns-control-reconciliation-dlq");
  assert.deepEqual(wrangler.secrets.required, [
    "GITHUB_APP_PRIVATE_KEY_PEM",
    "GITHUB_WEBHOOK_SECRET",
    "CONTROL_TELEGRAM_BOT_TOKEN",
    "CONTROL_TELEGRAM_CHAT_ID",
  ]);
});
