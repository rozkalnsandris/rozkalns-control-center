import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("active branch-rules reader remains Metadata-only and disconnected from the public Worker route", async () => {
  const [reader, worker, wrangler] = await Promise.all([
    source("src/integrations/github/active-branch-rules-reader.ts"),
    source("src/worker/index.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(reader, /rules\/branches\/\$\{encodedBranch\}\?per_page=100/);
  assert.match(reader, /"metadata"/);
  assert.match(reader, /combineBranchPolicyObservations\(\[observation\]/);
  assert.doesNotMatch(reader, /administration|branches\/\$\{[^}]+\}\/protection|\/protection/);
  assert.doesNotMatch(reader, /api\.github\.com|Authorization|Bearer|fetch\(/);
  assert.doesNotMatch(reader, /\b(?:POST|PUT|PATCH|DELETE)\b/);

  assert.doesNotMatch(worker, /active-branch-rules-reader|readGitHubActiveBranchPolicyEvidence/);
  assert.match(wrangler, /"binding": "CONTROL_DB"/);
  assert.match(wrangler, /"database_id": "8504e986-faf0-450c-bfb5-41b5dbf8be09"/);
  assert.doesNotMatch(wrangler, /"queues"/);
});
