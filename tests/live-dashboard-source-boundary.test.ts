import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("live dashboard remains bounded to read-only GitHub observation and disabled production config", async () => {
  const [dashboard, route, worker, runtime, wrangler] = await Promise.all([
    source("src/shared/live-dashboard.ts"),
    source("src/worker/github-dashboard-route.ts"),
    source("src/worker/index.ts"),
    source("src/integrations/github/cloudflare-worker-runtime.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(worker, /\/api\/github\/dashboard/);
  assert.match(worker, /CONTROL_LIVE_READ_ENABLED/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(route, /LIVE_DASHBOARD_FAILED/);
  assert.equal(route.includes("api.github.com"), false);
  assert.equal(dashboard.includes("listCommitStatuses"), false);
  assert.equal(dashboard.includes('return "MERGE_READY"'), false);
  assert.match(dashboard, /allowedActions:\s*\["OPEN_PR"\]/);
  assert.match(runtime, /memoizeGitHubInstallationSessionProvider/);
  assert.doesNotMatch(runtime, /"administration"|"statuses"/);
  assert.match(wrangler, /"CONTROL_LIVE_READ_ENABLED": "false"/);
});

test("live dashboard UI uses one same-origin snapshot request and keeps mutation actions mock-only", async () => {
  const [app, card] = await Promise.all([
    source("src/react-app/App.tsx"),
    source("src/react-app/components/DecisionCard.tsx"),
  ]);

  assert.equal(app.match(/fetch\("\/api\/github\/dashboard"/g)?.length, 1);
  assert.match(app, /AbortController/);
  assert.match(app, /LIVE READ-ONLY/);
  assert.match(app, /Live data unavailable · fixture data shown/);
  assert.doesNotMatch(app, /api\.github\.com/);
  assert.match(card, /action === "OPEN_PR" && item\.prUrl/);
  assert.match(card, /<a className=\{actionClass\(action\)\} href=\{item\.prUrl\}/);
  assert.match(card, /onMockAction\(action, item\)/);
});
