import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Telegram transport stays source-only and detached from live runtime wiring", async () => {
  const [
    adapterSource,
    runtimeAssembly,
    batchRuntime,
    workerSource,
    wranglerSource,
  ] = await Promise.all([
    readFile(
      "src/integrations/telegram/notification-delivery-dispatch-adapter.ts",
      "utf8",
    ),
    readFile(
      "src/integrations/cloudflare/control-webhook-queue-runtime.ts",
      "utf8",
    ),
    readFile(
      "src/integrations/cloudflare/cloudflare-reconciliation-batch-runtime.ts",
      "utf8",
    ),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);

  assert.match(adapterSource, /https:\/\/api\.telegram\.org/);
  assert.match(adapterSource, /redirect:\s*"manual"/);
  assert.match(adapterSource, /"content-type":\s*"application\/json"/);
  assert.doesNotMatch(adapterSource, /console\./);
  assert.doesNotMatch(adapterSource, /\.description\b/);

  const liveAssembly = [
    runtimeAssembly,
    batchRuntime,
    workerSource,
    wranglerSource,
  ].join("\n");
  assert.doesNotMatch(liveAssembly, /integrations\/telegram/);
  assert.doesNotMatch(liveAssembly, /api\.telegram\.org/);
  assert.doesNotMatch(liveAssembly, /TELEGRAM_(?:BOT_)?TOKEN/);
});
