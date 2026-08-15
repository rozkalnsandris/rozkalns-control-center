import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("authoritative GitHub provider remains transport-bounded and not directly wired into Worker routing", async () => {
  const [provider, worker] = await Promise.all([
    source("src/integrations/github/authoritative-read-provider.ts"),
    source("src/worker/index.ts"),
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
});
