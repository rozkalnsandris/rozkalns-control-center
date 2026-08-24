import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), "utf8");
}

test("Phase 3 Merge D1 audit persistence remains detached from Worker runtime, UI and production activation", async () => {
  const [
    storeSource,
    migrationSource,
    workerIndex,
    workerRuntime,
    dashboardRuntime,
    appSource,
    policySource,
    wranglerSource,
  ] = await Promise.all([
    source("src/integrations/cloudflare/d1-merge-decision-audit-store.ts"),
    source("migrations/0008_merge_decision_audit.sql"),
    source("src/worker/index.ts"),
    source("src/integrations/github/cloudflare-worker-runtime.ts"),
    source("src/integrations/github/cloudflare-dashboard-runtime.ts"),
    source("src/react-app/App.tsx"),
    source("src/shared/project-policy.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(storeSource, /implements MergeDecisionAuditStore/);
  assert.match(storeSource, /INSERT INTO merge_decisions/);
  assert.match(storeSource, /ON CONFLICT\(request_id\) DO NOTHING/);
  assert.match(storeSource, /AND fingerprint = \?2/);
  assert.match(storeSource, /AND state = 'IN_PROGRESS'/);
  assert.match(storeSource, /mutation_attempted/);

  assert.match(migrationSource, /CREATE TABLE merge_decisions/);
  assert.match(migrationSource, /merge_method TEXT NOT NULL/);
  assert.match(migrationSource, /mutation_attempted INTEGER/);
  assert.match(migrationSource, /state IN \('IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'UNKNOWN'\)/);
  assert.doesNotMatch(
    migrationSource,
    /^\s*(?:body|request_body|access_jwt|github_token|token|secret|private_key)\s+TEXT/im,
  );

  for (const runtimeSource of [workerIndex, workerRuntime, dashboardRuntime, appSource, wranglerSource]) {
    assert.doesNotMatch(runtimeSource, /d1-merge-decision-audit-store/);
    assert.doesNotMatch(runtimeSource, /D1MergeDecisionAuditStore/);
    assert.doesNotMatch(runtimeSource, /merge_decisions/);
    assert.doesNotMatch(runtimeSource, /\/api\/github\/merge/i);
  }

  assert.doesNotMatch(policySource, /canMerge/);
});

test("Merge D1 source persistence contains no live apply command or credential material", async () => {
  const [storeSource, migrationSource] = await Promise.all([
    source("src/integrations/cloudflare/d1-merge-decision-audit-store.ts"),
    source("migrations/0008_merge_decision_audit.sql"),
  ]);

  for (const text of [storeSource, migrationSource]) {
    assert.doesNotMatch(text, /wrangler\s+d1\s+migrations\s+apply/i);
    assert.doesNotMatch(text, /GITHUB_APP_PRIVATE_KEY_PEM/);
    assert.doesNotMatch(text, /CONTROL_ACCESS_TOKEN/);
    assert.doesNotMatch(text, /Authorization:\s*`Bearer/);
  }
});
