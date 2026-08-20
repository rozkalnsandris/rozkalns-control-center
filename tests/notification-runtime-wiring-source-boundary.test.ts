import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { notificationTransitionsEnabled } from "../src/integrations/cloudflare/control-webhook-queue-runtime.js";

test("notification transition runtime flag is exact and dormant by default", async () => {
  assert.equal(notificationTransitionsEnabled("true"), true);
  for (const value of [undefined, null, false, true, "false", "TRUE", "true ", " true", 1]) {
    assert.equal(notificationTransitionsEnabled(value), false);
  }

  const [runtimeAssembly, batchRuntime, worker, wranglerSource] = await Promise.all([
    readFile("src/integrations/cloudflare/control-webhook-queue-runtime.ts", "utf8"),
    readFile("src/integrations/cloudflare/cloudflare-reconciliation-batch-runtime.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
  ]);
  const wrangler = JSON.parse(wranglerSource) as {
    vars?: Record<string, unknown>;
  };

  assert.match(runtimeAssembly, /CONTROL_NOTIFICATION_TRANSITIONS_ENABLED/);
  assert.match(runtimeAssembly, /D1NotificationTransitionStore/);
  assert.match(runtimeAssembly, /notificationTransitionsEnabled/);
  assert.match(batchRuntime, /reconcileNotificationTransitions/);
  assert.match(batchRuntime, /notificationTransitionStore/);

  assert.equal(
    Object.prototype.hasOwnProperty.call(
      wrangler.vars ?? {},
      "CONTROL_NOTIFICATION_TRANSITIONS_ENABLED",
    ),
    false,
  );
  assert.doesNotMatch(worker, /CONTROL_NOTIFICATION_TRANSITIONS_ENABLED/);

  const combined = `${runtimeAssembly}\n${batchRuntime}`;
  assert.doesNotMatch(combined, /api\.telegram\.org|webpush|pushsubscription|vapid/i);
  assert.doesNotMatch(combined, /TELEGRAM_(BOT_)?TOKEN|VAPID_(PRIVATE_)?KEY/i);
});
