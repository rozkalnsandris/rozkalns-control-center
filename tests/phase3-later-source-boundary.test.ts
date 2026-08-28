import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("Later persistence remains detached from Worker, React network writes and production config", async () => {
  const [laterSource, storeSource, workerIndex, appSource, wranglerSource, migrationEntries] =
    await Promise.all([
      source("src/shared/later-decision.ts"),
      source("src/integrations/cloudflare/d1-later-deferral-store.ts"),
      source("src/worker/index.ts"),
      source("src/react-app/App.tsx"),
      source("wrangler.jsonc"),
      readdir("migrations"),
    ]);

  assert.match(laterSource, /createLaterDeferral/);
  assert.match(laterSource, /evaluateLaterDeferral/);
  assert.match(laterSource, /DEFERRED_UNCHANGED/);
  assert.match(laterSource, /RELEASE_MATERIAL_CHANGE/);
  assert.doesNotMatch(laterSource, /D1Database|CONTROL_DB|fetch\(|Request\(|Response\(|Cloudflare/i);

  assert.match(storeSource, /ON CONFLICT\(decision_id\) DO NOTHING/);
  assert.match(storeSource, /meta\.changes/);
  assert.match(storeSource, /UPDATE later_deferrals/);
  assert.match(storeSource, /expectedStateFingerprint/);
  assert.doesNotMatch(storeSource, /fetch\(|Request\(|Response\(|Access|JWT|CONTROL_LATER/i);

  assert.doesNotMatch(workerIndex, /d1-later-deferral-store|later-decision|\/api\/github\/later|CONTROL_LATER/i);
  assert.doesNotMatch(appSource, /\/api\/github\/later|fetch\([^\n]*later/i);
  assert.match(appSource, /handleMockAction/);
  assert.match(appSource, /demo only/);
  assert.doesNotMatch(wranglerSource, /CONTROL_LATER|later-decision|\/api\/github\/later/i);

  assert.equal(migrationEntries.includes("0009_later_deferrals.sql"), true);
  assert.equal(migrationEntries.filter((entry) => /later|deferral/i.test(entry)).length, 1);
});
