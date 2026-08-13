import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("Cloudflare GitHub runtime is wired only through the reviewed read-only Worker reconciliation route", async () => {
  const [runtime, route, worker, wrangler] = await Promise.all([
    source("src/integrations/github/cloudflare-worker-runtime.ts"),
    source("src/worker/github-reconciliation-route.ts"),
    source("src/worker/index.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(runtime, /from "node:crypto"/);
  assert.match(runtime, /GITHUB_APP_PRIVATE_KEY_PEM/);
  assert.match(runtime, /buildPhase2GitHubReadScopeForStage\(installationId, "actions"\)/);
  assert.doesNotMatch(runtime, /-----BEGIN|ghs_[A-Za-z0-9]/);
  assert.doesNotMatch(runtime, /wrangler|versions upload|secret put|deploy\(/i);

  assert.match(route, /ROUTE_PATH = "\/api\/github\/reconcile"/);
  assert.match(route, /createCloudflareGitHubReadRuntime/);
  assert.match(route, /reconcileAuthoritativePullRequestDecision/);
  assert.match(route, /commitStatusCoverage: "NOT_REQUESTED"/);
  assert.match(route, /deployImpact: "UNKNOWN"/);
  assert.match(route, /Cache-Control/);
  assert.doesNotMatch(route, /Authorization|Bearer|api\.github\.com|-----BEGIN|ghs_[A-Za-z0-9]/);
  assert.doesNotMatch(route, /\b(?:mergePullRequest|createPullRequest|updatePullRequest|requestChanges|rerunWorkflow|writeContents)\b/);

  assert.match(worker, /github-reconciliation-route/);
  assert.match(worker, /request\.method === "GET" && url\.pathname === "\/api\/health"/);
  assert.match(worker, /url\.pathname === "\/api\/github\/reconcile"/);
  assert.doesNotMatch(worker, /Authorization|Bearer|api\.github\.com|GITHUB_APP_PRIVATE_KEY_PEM/);

  assert.match(wrangler, /"GITHUB_APP_PRIVATE_KEY_PEM"/);
  assert.doesNotMatch(wrangler, /-----BEGIN|ghs_[A-Za-z0-9]/);
  assert.doesNotMatch(wrangler, /"d1_databases"|"queues"|"routes"|"route"/);
});
