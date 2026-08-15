import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("Cloudflare GitHub read runtime stays bounded while production Queue wiring is explicit", async () => {
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
  assert.match(wrangler, /"binding": "CONTROL_DB"/);
  assert.match(wrangler, /"database_id": "8504e986-faf0-450c-bfb5-41b5dbf8be09"/);
  assert.match(wrangler, /"binding": "RECONCILIATION_QUEUE"/);
  assert.match(wrangler, /"queue": "rozkalns-control-reconciliation"/);
  assert.match(wrangler, /"dead_letter_queue": "rozkalns-control-reconciliation-dlq"/);
  assert.doesNotMatch(wrangler, /-----BEGIN|ghs_[A-Za-z0-9]|test-webhook-secret/i);
  assert.doesNotMatch(wrangler, /"routes"|"route"/);
});

test("GitHub webhook Worker boundary authenticates raw bytes and remains fail-closed through reviewed runtime assembly", async () => {
  const [route, worker, wrangler] = await Promise.all([
    source("src/worker/github-webhook-route.ts"),
    source("src/worker/index.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(route, /request\.arrayBuffer\(\)/);
  assert.match(route, /authenticateGitHubWebhookRequest\(rawBody, request\.headers, options\.secret\)/);
  assert.match(route, /authenticated\.kind === "PING"/);
  assert.match(route, /resolveManagedProjectPolicy\(webhook\.repository\)/);
  assert.match(route, /MAX_GITHUB_WEBHOOK_BODY_BYTES = 1024 \* 1024/);
  assert.match(route, /DURABILITY_NOT_READY/);
  assert.doesNotMatch(route, /\bfetch\s*\(|D1Database|\bQueue\s*</);
  assert.doesNotMatch(route, /api\.github\.com|Authorization|Bearer/);

  assert.match(worker, /github-webhook-route/);
  assert.match(worker, /url\.pathname === "\/api\/github\/webhook"/);
  assert.match(worker, /resolveWebhookQueueRuntime\(env\)/);
  assert.match(worker, /resolution\.status === "READY"/);
  assert.match(worker, /secret:\s*null/);
  assert.match(worker, /acceptor:\s*null/);
  assert.doesNotMatch(worker, /GITHUB_WEBHOOK_SECRET|CONTROL_DB/);

  assert.match(wrangler, /"GITHUB_WEBHOOK_SECRET"/);
  assert.match(wrangler, /"binding": "CONTROL_DB"/);
  assert.match(wrangler, /"binding": "RECONCILIATION_QUEUE"/);
  assert.match(wrangler, /"rozkalns-control-reconciliation-dlq"/);
  assert.doesNotMatch(wrangler, /-----BEGIN|ghs_[A-Za-z0-9]|test-webhook-secret/i);
  assert.doesNotMatch(wrangler, /"routes"|"route"/);
});
