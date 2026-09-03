import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Telegram transport is source-wired but remains dormant in production configuration", async () => {
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

  // Worker entrypoint remains provider-agnostic; the existing queue resolver is
  // the only composition point. Production config still has no activation,
  // Telegram credential/destination or dispatch Queue binding.
  assert.doesNotMatch(workerSource, /integrations\/telegram|api\.telegram\.org/);
  for (const forbidden of [
    "CONTROL_NOTIFICATION_DISPATCH_ENABLED",
    "CONTROL_NOTIFICATION_RETRY_POLICY",
    "CONTROL_TELEGRAM_TARGET_KEY",
    "CONTROL_TELEGRAM_BOT_TOKEN",
    "CONTROL_TELEGRAM_CHAT_ID",
    "CONTROL_NOTIFICATION_CONTROL_ORIGIN",
    "NOTIFICATION_DISPATCH_QUEUE",
    "rozkalns-control-notification-dispatch",
    "api.telegram.org",
  ]) {
    assert.equal(wranglerSource.includes(forbidden), false);
  }
});
