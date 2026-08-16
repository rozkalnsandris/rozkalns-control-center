import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), "utf8");
}

test("Phase 3 D1 audit store remains detached from Worker runtime, UI and production activation", async () => {
  const [
    storeSource,
    migrationSource,
    workerIndex,
    workerRuntime,
    dashboardRuntime,
    appSource,
    wranglerSource,
  ] = await Promise.all([
    source("src/integrations/cloudflare/d1-needs-changes-audit-store.ts"),
    source("migrations/0002_needs_changes_audit.sql"),
    source("src/worker/index.ts"),
    source("src/integrations/github/cloudflare-worker-runtime.ts"),
    source("src/integrations/github/cloudflare-dashboard-runtime.ts"),
    source("src/react-app/App.tsx"),
    source("wrangler.jsonc"),
  ]);

  assert.match(storeSource, /implements NeedsChangesDecisionAuditStore/);
  assert.match(storeSource, /ON CONFLICT\(request_id\) DO NOTHING/);
  assert.match(storeSource, /AND fingerprint = \?2/);
  assert.match(storeSource, /AND state = 'IN_PROGRESS'/);

  assert.match(migrationSource, /CREATE TABLE needs_changes_decisions/);
  assert.match(migrationSource, /state IN \('IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'UNKNOWN'\)/);
  assert.doesNotMatch(migrationSource, /^\s*(?:body|review_body|access_jwt|github_token|token|secret|private_key)\s+TEXT/im);

  for (const runtimeSource of [workerIndex, workerRuntime, dashboardRuntime, appSource, wranglerSource]) {
    assert.doesNotMatch(runtimeSource, /d1-needs-changes-audit-store/);
    assert.doesNotMatch(runtimeSource, /D1NeedsChangesDecisionAuditStore/);
    assert.doesNotMatch(runtimeSource, /needs_changes_decisions/);
  }

  assert.doesNotMatch(workerIndex, /\/api\/.*needs-changes/i);
  assert.doesNotMatch(appSource, /\/api\/.*needs-changes/i);
});

test("D1 audit persistence never stores the review body or credential material", async () => {
  const [storeSource, migrationSource] = await Promise.all([
    source("src/integrations/cloudflare/d1-needs-changes-audit-store.ts"),
    source("migrations/0002_needs_changes_audit.sql"),
  ]);

  assert.doesNotMatch(storeSource, /review_body/);
  assert.doesNotMatch(storeSource, /GITHUB_APP_PRIVATE_KEY_PEM/);
  assert.doesNotMatch(storeSource, /CONTROL_ACCESS_TOKEN/);
  assert.doesNotMatch(storeSource, /Authorization:\s*`Bearer/);
  assert.doesNotMatch(migrationSource, /\b(?:review_body|access_jwt|github_token|private_key)\b\s+TEXT/i);
});
