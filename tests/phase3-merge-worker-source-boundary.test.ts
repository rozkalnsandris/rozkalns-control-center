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

test("Phase 3 Merge Worker boundary remains detached from production entrypoints and UI", () => {
  for (const forbidden of [
    "github-merge-route",
    "github-merge-runtime",
    "/api/github/merge",
    "GITHUB_MERGE_ROUTE_PATH",
    "handleGitHubMergeRequest",
    "resolveCloudflareMergeRuntime",
  ]) {
    assert.equal(workerIndex.includes(forbidden), false, `unexpected Worker Merge wiring: ${forbidden}`);
  }

  assert.equal(appSource.includes("/api/github/merge"), false);
  assert.equal(appSource.includes("GITHUB_MERGE_ROUTE_PATH"), false);

  assert.equal(wranglerConfig.includes("CONTROL_MERGE_ACCESS_ISSUER"), false);
  assert.equal(wranglerConfig.includes("CONTROL_MERGE_ACCESS_AUDIENCE"), false);
  assert.equal(wranglerConfig.includes("GITHUB_CONTENTS_WRITE_PERMISSION"), false);
  assert.equal(wranglerConfig.includes("contents:write"), false);
});

test("detached Merge handler and runtime retain independent fail-closed capability gates", () => {
  assert.match(routeSource, /resolveMergeProjectPolicy/);
  assert.match(routeSource, /project\.canMerge\s*!==\s*true/);
  assert.match(routeSource, /ACTION_NOT_ALLOWED/);
  assert.match(routeSource, /ACCESS_AUTHENTICATION_FAILED/);
  assert.match(routeSource, /WRITE_OUTCOME_UNKNOWN/);

  assert.match(runtimeSource, /requireMergeProjectPolicy\(request\.repository\)/);
  assert.match(runtimeSource, /D1MergeDecisionAuditStore/);
  assert.match(runtimeSource, /createGitHubAppMergeSessionProvider/);
  assert.match(runtimeSource, /createGitHubPullRequestMergeWriter/);
  assert.match(runtimeSource, /executeMergeDecision/);

  assert.equal((policySource.match(/canMerge:\s*false/g) ?? []).length, 6);
  assert.equal((policySource.match(/canMerge:\s*true/g) ?? []).length, 0);
});
