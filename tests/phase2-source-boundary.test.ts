import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("Phase 2 read contracts contain no live GitHub transport or mutation methods", async () => {
  const [provider, webhook, reconciliation] = await Promise.all([
    source("src/shared/source-control-read.ts"),
    source("src/shared/github-webhook.ts"),
    source("src/shared/github-reconciliation.ts"),
  ]);

  const combined = `${provider}\n${webhook}\n${reconciliation}`;

  assert.equal(combined.includes("api.github.com"), false);
  assert.equal(combined.includes("Authorization:"), false);
  assert.equal(combined.includes("fetch("), false);
  assert.doesNotMatch(provider, /\b(?:mergePullRequest|createPullRequest|updatePullRequest|requestChanges|rerunWorkflow|writeContents)\b/);
});

test("Phase 2 reconciliation model makes authoritative reread explicit", async () => {
  const [provider, reconciliation] = await Promise.all([
    source("src/shared/source-control-read.ts"),
    source("src/shared/github-reconciliation.ts"),
  ]);

  assert.match(provider, /authoritativeRead:\s*true/);
  assert.match(reconciliation, /authoritativeReadRequired:\s*true/);
  assert.match(reconciliation, /requireManagedProjectPolicy/);
});
