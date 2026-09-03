import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("current-state docs describe the live-read Worker, D1 and Queue source architecture", async () => {
  const [readme, checkpoint] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("docs/ROADMAP_CURRENT_CHECKPOINT.md", "utf8"),
  ]);
  const currentDocs = `${readme}\n${checkpoint}`;

  for (const required of [
    "CONTROL_DB",
    "GET /api/github/dashboard",
    "POST /api/github/webhook",
    "Queue",
    "0010_webhook_observability_hot_index.sql",
    "conditional GET",
    "rate-limit",
    "security headers",
    "bounded timeout",
  ]) {
    assert.match(currentDocs, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  assert.doesNotMatch(readme, /There are still \*\*no live GitHub API calls/i);
  assert.doesNotMatch(readme, /Current Phase 2 source preflight/i);
  assert.doesNotMatch(readme, /remain disconnected from `src\/worker\/index\.ts`/i);
  assert.match(currentDocs, /source (?:and configuration )?(?:describe|prove)[^\n]*not[^\n]*production/i);
  assert.match(currentDocs, /issue #278|#278/);
});

test("durable roadmap checkpoint excludes transient execution identifiers and receipts", async () => {
  const checkpoint = await readFile("docs/ROADMAP_CURRENT_CHECKPOINT.md", "utf8");

  assert.doesNotMatch(checkpoint, /\b(?:CI )?run\s+`?\d{6,}/i);
  assert.doesNotMatch(checkpoint, /\bdeployment\s+`?[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  assert.doesNotMatch(checkpoint, /\bauthorization receipt\b/i);
  assert.doesNotMatch(checkpoint, /\bmain=[0-9a-f]{40}\b/i);
});
