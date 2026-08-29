import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

test("guarded Merge decision is Worker-reachable and source-bounded to ops-workflows while production activation remains separate", async () => {
  const [decisionSource, workerIndex, workerRuntime, appSource, policySource, wranglerSource] = await Promise.all([
    source("src/shared/merge-decision.ts"),
    source("src/worker/index.ts"),
    source("src/integrations/github/cloudflare-worker-runtime.ts"),
    source("src/react-app/App.tsx"),
    source("src/shared/project-policy.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(decisionSource, /reconcileAuthoritativePullRequestDecision/);
  assert.match(decisionSource, /decision\.workflowState !== "MERGE_READY"/);
  assert.match(decisionSource, /decision\.ci !== "PASS"/);
  assert.match(decisionSource, /isReviewRequirementSatisfied\(decision\.review\)/);
  assert.match(decisionSource, /expectedHeadSha:\s*normalized\.expectedHeadSha/);
  assert.match(decisionSource, /mergeMethod:\s*normalized\.mergeMethod/);
  assert.match(decisionSource, /kind:\s*"UNKNOWN"/);
  assert.match(decisionSource, /WRITE_OUTCOME_UNKNOWN/);
  assert.doesNotMatch(decisionSource, /D1Database/);
  assert.doesNotMatch(decisionSource, /CONTROL_DB/);

  assert.match(workerIndex, /GITHUB_MERGE_ROUTE_PATH/);
  assert.match(workerIndex, /handleGitHubMergeRequest/);
  assert.match(workerIndex, /resolveCloudflareMergeRuntime/);
  assert.doesNotMatch(workerIndex, /merge-decision|executeMergeDecision/);

  for (const runtimeSource of [workerRuntime, appSource]) {
    assert.doesNotMatch(runtimeSource, /merge-decision/);
    assert.doesNotMatch(runtimeSource, /executeMergeDecision/);
    assert.doesNotMatch(runtimeSource, /\/api\/github\/merge/i);
  }

  assert.equal((policySource.match(/canMerge:\s*false/g) ?? []).length, 5);
  assert.equal((policySource.match(/canMerge:\s*true/g) ?? []).length, 1);
  assert.match(
    policySource,
    /repository: "rozkalnsandris\/ops-workflows"[^\n]+canMerge: true/,
  );
  assert.match(wranglerSource, /CONTROL_MERGE_ACCESS_ISSUER/);
  assert.match(wranglerSource, /CONTROL_MERGE_ACCESS_AUDIENCE/);
  assert.doesNotMatch(wranglerSource, /contents:write|GITHUB_CONTENTS_WRITE_PERMISSION/i);
});

test("guarded Merge decision source does not introduce a concrete Merge persistence adapter or migration", async () => {
  const [decisionSource, packageSource] = await Promise.all([
    source("src/shared/merge-decision.ts"),
    source("package.json"),
  ]);

  assert.match(decisionSource, /interface MergeDecisionAuditStore/);
  assert.doesNotMatch(decisionSource, /class D1/);
  assert.doesNotMatch(decisionSource, /INSERT\s+INTO/i);
  assert.doesNotMatch(decisionSource, /UPDATE\s+/i);
  assert.doesNotMatch(packageSource, /merge.*migration/i);
});
