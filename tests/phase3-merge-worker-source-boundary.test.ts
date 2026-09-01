import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
const policySource = readFileSync(resolve(process.cwd(), "src/shared/project-policy.ts"), "utf8");
const routeSource = readFileSync(resolve(process.cwd(), "src/worker/github-merge-route.ts"), "utf8");
const runtimeSource = readFileSync(resolve(process.cwd(), "src/worker/github-merge-runtime.ts"), "utf8");

test("Phase 3 Merge route is Worker-reachable while capability is source-bounded to ops-workflows", () => {
  assert.match(workerIndex, /GITHUB_MERGE_ROUTE_PATH/);
  assert.match(workerIndex, /handleGitHubMergeRequest/);
  assert.match(workerIndex, /resolveCloudflareMergeRuntime/);
  assert.match(workerIndex, /function resolveMergeRuntime\(env: Env\)/);
  assert.match(workerIndex, /url\.pathname === GITHUB_MERGE_ROUTE_PATH/);
  assert.match(
    workerIndex,
    /handleGitHubMergeRequest\(request, resolveMergeRuntime\(env\)\)/,
  );

  assert.equal(appSource.includes("/api/github/merge"), false);
  assert.equal(appSource.includes("GITHUB_MERGE_ROUTE_PATH"), false);

  assert.match(wranglerConfig, /"CONTROL_MERGE_ACCESS_ISSUER"\s*:/);
  assert.match(wranglerConfig, /"CONTROL_MERGE_ACCESS_AUDIENCE"\s*:/);
  assert.equal(wranglerConfig.includes("GITHUB_CONTENTS_WRITE_PERMISSION"), false);
  assert.equal(wranglerConfig.includes("contents:write"), false);

  assert.equal((policySource.match(/canMerge:\s*false/g) ?? []).length, 5);
  assert.equal((policySource.match(/canMerge:\s*true/g) ?? []).length, 1);
  assert.match(
    policySource,
    /repository: "rozkalnsandris\/ops-workflows"[^\n]+canMerge: true/,
  );
});

test("reachable Merge handler and runtime retain independent fail-closed capability gates", () => {
  assert.match(routeSource, /resolveMergeProjectPolicy/);
  assert.match(routeSource, /project\.canMerge\s*!==\s*true/);
  assert.match(routeSource, /ACTION_NOT_ALLOWED/);
  assert.match(routeSource, /ACCESS_AUTHENTICATION_FAILED/);
  assert.match(routeSource, /WRITE_OUTCOME_UNKNOWN/);

  assert.match(runtimeSource, /requireMergeProjectPolicy\(request\.repository\)/);
  assert.match(runtimeSource, /if \(issuer === null \|\| audience === null\) return null/);
  assert.match(runtimeSource, /D1MergeDecisionAuditStore/);
  assert.match(runtimeSource, /createGitHubAppMergeSessionProvider/);
  assert.match(runtimeSource, /createGitHubPullRequestMergeWriter/);
  assert.match(runtimeSource, /executeMergeDecision/);
});

test("Merge UI keeps a synchronous duplicate-submit lock through the terminal canonical refresh", () => {
  assert.match(appSource, /const actionLockRef=useRef\(false\)/);
  assert.match(
    appSource,
    /function openDecisionAction\([^)]*\)\{if\(liveState!=="LIVE"\|\|actionLockRef\.current\|\|actionInFlight\)return;/,
  );
  assert.match(
    appSource,
    /async function confirmDecisionAction\([^)]*\)\{const target=pendingAction;if\(!target\|\|liveState!=="LIVE"\|\|actionLockRef\.current\|\|actionInFlight\)return;actionLockRef\.current=true;setActionInFlight\(true\);/,
  );
  assert.match(appSource, /finally\{actionLockRef\.current=false;setActionInFlight\(false\);setPendingAction\(null\);refreshLiveDashboard\(true\);\}/);
});