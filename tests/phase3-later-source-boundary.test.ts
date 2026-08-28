import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("Later route is source-wired but capability-disabled and UI-unwired", async () => {
  const [
    laterSource,
    actionSource,
    storeSource,
    routeSource,
    runtimeSource,
    policySource,
    workerIndex,
    appSource,
    wranglerSource,
    migrationEntries,
  ] = await Promise.all([
    source("src/shared/later-decision.ts"),
    source("src/shared/later-action.ts"),
    source("src/integrations/cloudflare/d1-later-deferral-store.ts"),
    source("src/worker/github-later-route.ts"),
    source("src/worker/github-later-runtime.ts"),
    source("src/shared/project-policy.ts"),
    source("src/worker/index.ts"),
    source("src/react-app/App.tsx"),
    source("wrangler.jsonc"),
    readdir("migrations"),
  ]);

  assert.match(laterSource, /createLaterDeferral/);
  assert.match(laterSource, /evaluateLaterDeferral/);
  assert.match(laterSource, /DEFERRED_UNCHANGED/);
  assert.match(laterSource, /RELEASE_MATERIAL_CHANGE/);
  assert.doesNotMatch(laterSource, /D1Database|CONTROL_DB|fetch\(|Request\(|Response\(|Cloudflare/i);

  assert.match(actionSource, /readDashboard/);
  assert.match(actionSource, /laterDecisionStateFingerprint/);
  assert.match(actionSource, /AUTHORIZATION_STALE_STATE/);
  assert.match(actionSource, /allowedActions\.includes\("LATER"\)/);
  assert.match(actionSource, /store\.claim/);
  assert.match(actionSource, /store\.replace/);
  assert.doesNotMatch(actionSource, /CloudflareAccess|Cf-Access|CONTROL_LATER_ACCESS/i);

  assert.match(storeSource, /ON CONFLICT\(decision_id\) DO NOTHING/);
  assert.match(storeSource, /meta\.changes/);
  assert.match(storeSource, /UPDATE later_deferrals/);
  assert.match(storeSource, /expectedStateFingerprint/);
  assert.doesNotMatch(storeSource, /fetch\(|Request\(|Response\(|Access|JWT|CONTROL_LATER/i);

  assert.match(routeSource, /GITHUB_LATER_ROUTE_PATH = "\/api\/github\/later"/);
  assert.match(routeSource, /authenticateRequest/);
  assert.match(routeSource, /resolveLaterProjectPolicy/);
  assert.match(routeSource, /project\.canLater !== true/);
  assert.match(routeSource, /expectedStateFingerprint/);

  assert.match(runtimeSource, /CloudflareAccessRequestAuthenticator/);
  assert.match(runtimeSource, /readCloudflareGitHubDashboardSnapshot/);
  assert.match(runtimeSource, /D1LaterDeferralStore/);
  assert.match(runtimeSource, /requireLaterProjectPolicy/);
  assert.match(runtimeSource, /CONTROL_LATER_ACCESS_ISSUER/);
  assert.match(runtimeSource, /CONTROL_LATER_ACCESS_AUDIENCE/);

  assert.match(workerIndex, /GITHUB_LATER_ROUTE_PATH/);
  assert.match(workerIndex, /handleGitHubLaterRequest/);
  assert.match(workerIndex, /resolveCloudflareLaterRuntime/);

  assert.equal((policySource.match(/canLater: false/g) ?? []).length, 6);
  assert.equal((policySource.match(/canLater: true/g) ?? []).length, 0);
  assert.match(policySource, /resolveLaterProjectPolicy/);
  assert.match(policySource, /requireLaterProjectPolicy/);

  assert.doesNotMatch(appSource, /\/api\/github\/later|fetch\([^\n]*later/i);
  assert.match(appSource, /handleMockAction/);
  assert.match(appSource, /demo only/);

  assert.match(wranglerSource, /CONTROL_LATER_ACCESS_ISSUER/);
  assert.match(wranglerSource, /CONTROL_LATER_ACCESS_AUDIENCE/);
  assert.doesNotMatch(wranglerSource, /CONTROL_LATER_RUNTIME_ENABLED/);

  assert.equal(migrationEntries.includes("0009_later_deferrals.sql"), true);
  assert.equal(migrationEntries.filter((entry) => /later|deferral/i.test(entry)).length, 1);
});
