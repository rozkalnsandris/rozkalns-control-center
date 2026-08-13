import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("authoritative GitHub provider remains transport-bounded and disconnected from the public Worker route", async () => {
  const [provider, worker, wrangler] = await Promise.all([
    source("src/integrations/github/authoritative-read-provider.ts"),
    source("src/worker/index.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(provider, /SourceControlReadProvider/);
  assert.match(provider, /GitHubInstallationReadTransport/);
  assert.match(provider, /GitHubGraphqlMergeStateTransport/);
  assert.match(provider, /filter=all&per_page=100/);
  assert.match(provider, /commitStatusCoverage: options\.commitStatusCoverage/);

  assert.doesNotMatch(provider, /api\.github\.com|Authorization|Bearer|fetch\(/);
  assert.doesNotMatch(provider, /app-installation-session|private.?key|webhook.?secret/i);
  assert.doesNotMatch(provider, /\b(?:POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(worker, /authoritative-read-provider|readGitHubAuthoritativePullRequestSnapshot/);
  assert.match(wrangler, /"binding": "CONTROL_DB"/);
  assert.match(wrangler, /"database_id": "8504e986-faf0-450c-bfb5-41b5dbf8be09"/);
  assert.doesNotMatch(wrangler, /"queues"/);
});
