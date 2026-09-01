import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("live dashboard remains bounded observation and projects mutation actions only through explicit project capability", async () => {
  const [dashboard, route, worker, runtime, wrangler, policy] = await Promise.all([
    source("src/shared/live-dashboard.ts"),
    source("src/worker/github-dashboard-route.ts"),
    source("src/worker/index.ts"),
    source("src/integrations/github/cloudflare-worker-runtime.ts"),
    source("wrangler.jsonc"),
    source("src/shared/project-policy.ts"),
  ]);

  assert.match(worker, /\/api\/github\/dashboard/);
  assert.match(worker, /CONTROL_LIVE_READ_ENABLED/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(route, /LIVE_DASHBOARD_FAILED/);
  assert.equal(route.includes("api.github.com"), false);
  assert.equal(dashboard.includes("listCommitStatuses"), false);
  assert.equal(dashboard.includes('return "MERGE_READY"'), false);
  assert.match(dashboard, /allowedActionsForLiveDecision/);
  assert.match(dashboard, /policy\.canMerge/);
  assert.match(dashboard, /policy\.canRequestChanges/);
  assert.match(dashboard, /policy\.canLater/);
  assert.match(dashboard, /decision\.issueNumber !== null/);
  assert.match(dashboard, /decision\.workflowState === "MERGE_READY"/);
  assert.match(dashboard, /actions\.push\("LATER"\)/);
  assert.match(dashboard, /actions\.push\("OPEN_PR"\)/);
  assert.equal((policy.match(/canMerge: false/g) ?? []).length, 5);
  assert.equal((policy.match(/canMerge: true/g) ?? []).length, 1);
  assert.match(policy, /repository: "rozkalnsandris\/ops-workflows"[^\n]+canMerge: true/);
  assert.equal((policy.match(/canLater: true/g) ?? []).length, 1);
  assert.match(runtime, /memoizeGitHubInstallationSessionProvider/);
  assert.doesNotMatch(runtime, /"administration"|"statuses"/);
  assert.match(wrangler, /"CONTROL_LIVE_READ_ENABLED": "true"/);
});

test("live dashboard UI uses one same-origin snapshot request and one authoritative hydration before confirmed writes", async () => {
  const [app, card, client, eligibility] = await Promise.all([
    source("src/react-app/App.tsx"),
    source("src/react-app/components/DecisionCard.tsx"),
    source("src/react-app/decision-action-client.ts"),
    source("src/react-app/needs-changes-eligibility-client.ts"),
  ]);

  assert.equal(app.match(/fetch\("\/api\/github\/dashboard"/g)?.length, 1);
  assert.match(app, /AbortController/);
  assert.match(app, /LIVE CONTROL/);
  assert.match(app, /Live data unavailable · fixture data shown/);
  assert.match(app, /ActionConfirmationDialog/);
  assert.match(app, /postDecisionAction/);
  assert.doesNotMatch(app, /api\.github\.com/);
  assert.match(card, /action\s*===\s*"OPEN_PR"/);
  assert.match(card, /onAction\(action,\s*renderedItem,\s*project\)/);
  assert.match(card, /applyAuthoritativeGitHubWriteEligibility/);
  assert.equal(card.match(/readAuthoritativeGitHubWriteEligibility\(/g)?.length, 1);
  assert.doesNotMatch(card, /readAuthoritativeNeedsChangesEligibility/);
  assert.doesNotMatch(card, /fetch\(/);
  assert.match(eligibility, /resolveManagedProjectPolicy/);
  assert.match(eligibility, /policy\.canMerge/);
  assert.match(eligibility, /policy\.canRequestChanges/);
  assert.match(eligibility, /\/api\/github\/reconcile/);
  assert.match(eligibility, /method:\s*"GET"/);
  assert.match(client, /"\/api\/github\/merge"/);
  assert.match(client, /"\/api\/github\/needs-changes"/);
  assert.match(client, /"\/api\/github\/later"/);
  assert.match(client, /method:\s*"POST"/);
  assert.doesNotMatch(client, /api\.github\.com/);
});
