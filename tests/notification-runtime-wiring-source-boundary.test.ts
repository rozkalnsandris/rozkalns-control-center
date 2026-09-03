import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  notificationDispatchEnabled,
  notificationTargetKeys,
  notificationTransitionsEnabled,
} from "../src/integrations/cloudflare/control-webhook-queue-runtime.js";

test("notification dispatch runtime wiring is exact and activation config is source-declared", async () => {
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
    secrets?: { required?: string[] };
    queues?: {
      producers?: Array<{ readonly binding?: string; readonly queue?: string }>;
      consumers?: Array<{
        readonly queue?: string;
        readonly max_batch_size?: number;
        readonly max_batch_timeout?: number;
        readonly max_retries?: number;
        readonly retry_delay?: number;
        readonly max_concurrency?: number;
      }>;
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

  const expectedVars: Readonly<Record<string, string>> = {
    CONTROL_NOTIFICATION_TRANSITIONS_ENABLED: "true",
    CONTROL_NOTIFICATION_TARGET_KEYS: '["primary"]',
    CONTROL_NOTIFICATION_DISPATCH_ENABLED: "true",
    CONTROL_NOTIFICATION_RETRY_POLICY:
      '{"schemaVersion":1,"maxAttempts":2,"retryDelaysSeconds":[60]}',
    CONTROL_TELEGRAM_TARGET_KEY: "primary",
    CONTROL_NOTIFICATION_CONTROL_ORIGIN: "https://control.rozkalns.net",
  };
  for (const [binding, expected] of Object.entries(expectedVars)) {
    assert.equal(wrangler.vars?.[binding], expected);
    assert.doesNotMatch(worker, new RegExp(binding));
  }

  for (const binding of ["CONTROL_TELEGRAM_BOT_TOKEN", "CONTROL_TELEGRAM_CHAT_ID"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(wrangler.vars ?? {}, binding), false);
    assert.doesNotMatch(worker, new RegExp(binding));
  }
  assert.deepEqual(wrangler.secrets?.required, [
    "GITHUB_APP_PRIVATE_KEY_PEM",
    "GITHUB_WEBHOOK_SECRET",
    "CONTROL_TELEGRAM_BOT_TOKEN",
    "CONTROL_TELEGRAM_CHAT_ID",
  ]);

  assert.deepEqual(
    (wrangler.queues?.producers ?? []).find(
      (producer) => producer.binding === "NOTIFICATION_DISPATCH_QUEUE",
    ),
    {
      binding: "NOTIFICATION_DISPATCH_QUEUE",
      queue: "rozkalns-control-notification-dispatch",
    },
  );
  assert.deepEqual(
    (wrangler.queues?.consumers ?? []).find(
      (consumer) => consumer.queue === "rozkalns-control-notification-dispatch",
    ),
    {
      queue: "rozkalns-control-notification-dispatch",
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 3,
      retry_delay: 60,
      max_concurrency: 1,
    },
  );

  const providerBoundary = `${runtimeAssembly}\n${batchRuntime}\n${dispatchRuntime}\n${worker}\n${wranglerSource}`;
  assert.doesNotMatch(providerBoundary, /https:\/\/api\.telegram\.org/);
  assert.doesNotMatch(providerBoundary, /webpush|pushsubscription|vapid/i);
});
