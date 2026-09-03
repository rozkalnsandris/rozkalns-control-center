import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Telegram transport and exact activation configuration remain source-bounded", async () => {
  const [adapterSource, runtimeAssembly, dispatchRuntime, workerSource, wranglerSource] =
    await Promise.all([
      readFile(
        "src/integrations/telegram/notification-delivery-dispatch-adapter.ts",
        "utf8",
      ),
      readFile(
        "src/integrations/cloudflare/control-webhook-queue-runtime.ts",
        "utf8",
      ),
      readFile(
        "src/integrations/cloudflare/cloudflare-notification-dispatch-queue-runtime.ts",
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

  assert.match(runtimeAssembly, /createTelegramNotificationDeliveryDispatchAdapter/);
  assert.match(runtimeAssembly, /CONTROL_NOTIFICATION_DISPATCH_ENABLED/);
  assert.match(runtimeAssembly, /CONTROL_TELEGRAM_BOT_TOKEN/);
  assert.match(runtimeAssembly, /CONTROL_TELEGRAM_CHAT_ID/);
  assert.match(dispatchRuntime, /coordinateNotificationDeliveryDispatch/);
  assert.match(dispatchRuntime, /planNotificationDeliveryDispatch/);

  // The Worker entrypoint stays provider-agnostic. Source now declares the exact
  // deploy-time activation contract, while credential values remain outside git
  // and any actual production deployment remains separately LIVE-gated.
  assert.doesNotMatch(workerSource, /integrations\/telegram|api\.telegram\.org/);
  assert.match(wranglerSource, /"CONTROL_NOTIFICATION_TRANSITIONS_ENABLED": "true"/);
  assert.match(wranglerSource, /"CONTROL_NOTIFICATION_TARGET_KEYS": "\[\\"primary\\"\]"/);
  assert.match(wranglerSource, /"CONTROL_NOTIFICATION_DISPATCH_ENABLED": "true"/);
  assert.match(
    wranglerSource,
    /"CONTROL_NOTIFICATION_RETRY_POLICY": "\{\\"schemaVersion\\":1,\\"maxAttempts\\":2,\\"retryDelaysSeconds\\":\[60\]\}"/,
  );
  assert.match(wranglerSource, /"CONTROL_TELEGRAM_TARGET_KEY": "primary"/);
  assert.match(
    wranglerSource,
    /"CONTROL_NOTIFICATION_CONTROL_ORIGIN": "https:\/\/control\.rozkalns\.net"/,
  );
  assert.match(wranglerSource, /"CONTROL_TELEGRAM_BOT_TOKEN"/);
  assert.match(wranglerSource, /"CONTROL_TELEGRAM_CHAT_ID"/);
  assert.match(wranglerSource, /"binding": "NOTIFICATION_DISPATCH_QUEUE"/);
  assert.match(wranglerSource, /"queue": "rozkalns-control-notification-dispatch"/);
  assert.match(wranglerSource, /"max_batch_size": 10/);
  assert.match(wranglerSource, /"max_batch_timeout": 5/);
  assert.match(wranglerSource, /"max_retries": 3/);
  assert.match(wranglerSource, /"retry_delay": 60/);
  assert.match(wranglerSource, /"max_concurrency": 1/);

  assert.doesNotMatch(wranglerSource, /"CONTROL_TELEGRAM_BOT_TOKEN"\s*:/);
  assert.doesNotMatch(wranglerSource, /"CONTROL_TELEGRAM_CHAT_ID"\s*:/);
  assert.doesNotMatch(wranglerSource, /api\.telegram\.org/);
});
