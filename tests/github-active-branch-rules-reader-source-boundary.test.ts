import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("active branch-rules reader remains Metadata-only and not directly wired into Worker routing", async () => {
  const [reader, worker] = await Promise.all([
    source("src/integrations/github/active-branch-rules-reader.ts"),
    source("src/worker/index.ts"),
  ]);

  assert.match(reader, /rules\/branches\/\$\{encodedBranch\}\?per_page=100/);
  assert.match(reader, /"metadata"/);
  assert.match(reader, /combineBranchPolicyObservations\(\[observation\]/);
  assert.doesNotMatch(reader, /administration|branches\/\$\{[^}]+\}\/protection|\/protection/);
  assert.doesNotMatch(reader, /api\.github\.com|Authorization|Bearer|fetch\(/);
  assert.doesNotMatch(reader, /\b(?:POST|PUT|PATCH|DELETE)\b/);

  assert.doesNotMatch(worker, /active-branch-rules-reader|readGitHubActiveBranchPolicyEvidence/);
});
