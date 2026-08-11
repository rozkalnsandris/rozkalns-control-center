import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("authoritative GitHub provider remains source-only and transport-bounded", async () => {
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
  assert.doesNotMatch(wrangler, /"secrets"|"vars"|"d1_databases"|"queues"/);
});
