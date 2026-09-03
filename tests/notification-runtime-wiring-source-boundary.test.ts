import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  notificationDispatchEnabled,
  notificationTargetKeys,
  notificationTransitionsEnabled,
} from "../src/integrations/cloudflare/control-webhook-queue-runtime.js";

test("notification dispatch runtime wiring is exact and dormant by default", async () => {
  assert.equal(notificationTransitionsEnabled("true"), true);
  assert.equal(notificationDispatchEnabled("true"), true);
  for (const value of [undefined, null, false, true, "false", "TRUE", "true ", " true", 1]) {
    assert.equal(notificationTransitionsEnabled(value), false);
    assert.equal(notificationDispatchEnabled(value), false);
  }
  assert.deepEqual(notificationTargetKeys('["primary","backup"]'), ["primary", "backup"]);

  const [runtimeAssembly, batchRuntime, dispatchRuntime, worker, wranglerSource] =
    await Promise.all([
      readFile("src/integrations/cloudflare/control-webhook-queue-runtime.ts", "utf8"),
      readFile(
        "src/integrations/cloudflare/cloudflare-reconciliation-batch-runtime.ts",
        "utf8",
      ),
      readFile(
        "src/integrations/cloudflare/cloudflare-notification-dispatch-queue-runtime.ts",
        "utf8",
      ),
      readFile("src/worker/index.ts", "utf8"),
      readFile("wrangler.jsonc", "utf8"),
    ]);
  const wrangler = JSON.parse(wranglerSource) as {
    vars?: Record<string, unknown>;
    queues?: {
      producers?: Array<{ readonly binding?: string; readonly queue?: string }>;
      consumers?: Array<{ readonly queue?: string }>;
    };
  };

  assert.match(runtimeAssembly, /CONTROL_NOTIFICATION_TRANSITIONS_ENABLED/);
  assert.match(runtimeAssembly, /CONTROL_NOTIFICATION_TARGET_KEYS/);
  assert.match(runtimeAssembly, /CONTROL_NOTIFICATION_DISPATCH_ENABLED/);
  assert.match(runtimeAssembly, /createTelegramNotificationDeliveryDispatchAdapter/);
  assert.match(runtimeAssembly, /createCloudflareNotificationDispatchQueueRuntime/);
  assert.match(batchRuntime, /createNotificationDeliveryDispatchQueueMessage/);
  assert.match(batchRuntime, /dispatchQueue/);
  assert.match(dispatchRuntime, /D1NotificationDeliveryIntentStore/);
  assert.match(dispatchRuntime, /D1NotificationDeliveryAttemptStore/);
  assert.match(dispatchRuntime, /D1NotificationDeliveryDispatchClaimStore/);
  assert.match(dispatchRuntime, /coordinateNotificationDeliveryDispatch/);
  assert.match(dispatchRuntime, /planNotificationDeliveryDispatch/);

  for (const binding of [
    "CONTROL_NOTIFICATION_TRANSITIONS_ENABLED",
    "CONTROL_NOTIFICATION_TARGET_KEYS",
    "CONTROL_NOTIFICATION_DISPATCH_ENABLED",
    "CONTROL_NOTIFICATION_RETRY_POLICY",
    "CONTROL_TELEGRAM_TARGET_KEY",
    "CONTROL_TELEGRAM_BOT_TOKEN",
    "CONTROL_TELEGRAM_CHAT_ID",
    "CONTROL_NOTIFICATION_CONTROL_ORIGIN",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(wrangler.vars ?? {}, binding), false);
    assert.doesNotMatch(worker, new RegExp(binding));
  }

  assert.equal(
    (wrangler.queues?.producers ?? []).some(
      (producer) =>
        producer.binding === "NOTIFICATION_DISPATCH_QUEUE" ||
        producer.queue === "rozkalns-control-notification-dispatch",
    ),
    false,
  );
  assert.equal(
    (wrangler.queues?.consumers ?? []).some(
      (consumer) => consumer.queue === "rozkalns-control-notification-dispatch",
    ),
    false,
  );

  const providerBoundary = `${runtimeAssembly}\n${batchRuntime}\n${dispatchRuntime}\n${worker}\n${wranglerSource}`;
  assert.doesNotMatch(providerBoundary, /https:\/\/api\.telegram\.org/);
  assert.doesNotMatch(providerBoundary, /webpush|pushsubscription|vapid/i);
});
