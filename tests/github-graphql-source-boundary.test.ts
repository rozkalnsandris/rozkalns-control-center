import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("dedicated GraphQL integration owns the fixed query endpoint and exposes no mutation document", async () => {
  const [graphql, worker, sharedProvider] = await Promise.all([
    source("src/integrations/github/graphql-merge-state-transport.ts"),
    source("src/worker/index.ts"),
    source("src/shared/source-control-read.ts"),
  ]);

  assert.match(graphql, /GITHUB_GRAPHQL_ENDPOINT = "https:\/\/api\.github\.com\/graphql"/);
  assert.match(graphql, /query ControlPullRequestMergeState/);
  assert.match(graphql, /headRefOid/);
  assert.match(graphql, /mergeStateStatus/);
  assert.match(graphql, /isDraft/);
  assert.doesNotMatch(graphql, /\bmutation\s+[A-Za-z_]/);
  assert.doesNotMatch(graphql, /__schema|__type\s*\(/);
  assert.doesNotMatch(worker, /graphql-merge-state-transport|api\.github\.com\/graphql|Authorization|Bearer/);
  assert.doesNotMatch(sharedProvider, /api\.github\.com\/graphql|Authorization|Bearer/);
});

test("REST transport remains GET-only after GraphQL session support is added", async () => {
  const rest = await source("src/integrations/github/rest-read-transport.ts");
  assert.match(rest, /method: "GET"/);
  assert.doesNotMatch(rest, /GITHUB_GRAPHQL_ENDPOINT|ControlPullRequestMergeState/);
  assert.doesNotMatch(rest, /\b(?:POST|PUT|PATCH|DELETE)\b/);
});

test("GitHub App session keeps raw authorization primitives inside the dedicated integration layer", async () => {
  const [session, graphql, wrangler] = await Promise.all([
    source("src/integrations/github/app-installation-session.ts"),
    source("src/integrations/github/graphql-merge-state-transport.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(session, /Authorization: `Bearer \$\{rawCredential\}`/);
  assert.match(session, /createGitHubAppInstallationGraphqlSessionProvider/);
  assert.doesNotMatch(graphql, /Authorization|Bearer|ghs_/);
  assert.doesNotMatch(graphql, /token\.startsWith|token\.length/);
  assert.doesNotMatch(wrangler, /-----BEGIN|ghs_|test-webhook-secret/i);
});
