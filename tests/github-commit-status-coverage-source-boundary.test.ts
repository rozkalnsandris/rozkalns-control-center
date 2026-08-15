import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("commit-status coverage remains a pure source-only least-privilege boundary", async () => {
  const [readContract, projection, worker] = await Promise.all([
    source("src/shared/source-control-read.ts"),
    source("src/shared/github-projection.ts"),
    source("src/worker/index.ts"),
  ]);

  assert.match(readContract, /CommitStatusEvidenceCoverage = "OBSERVED" \| "NOT_REQUESTED"/);
  assert.match(readContract, /commitStatusCoverage === "OBSERVED"/);
  assert.match(readContract, /Promise\.resolve<CommitStatusRead\[]>\(\[\]\)/);
  assert.match(projection, /commitStatusCoverage === "NOT_REQUESTED"/);
  assert.match(projection, /states\.push\("waiting"\)/);
  assert.match(projection, /cannot be present when its source was not requested/);

  const combined = `${readContract}\n${projection}`;
  assert.doesNotMatch(combined, /api\.github\.com|Authorization|Bearer|fetch\(/);
  assert.doesNotMatch(combined, /\b(?:POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(worker, /commitStatusCoverage|listCommitStatuses|api\.github\.com/);
});
