import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPath = ".github/workflows/phase3-later-readonly-preflight.yml";
const source = readFileSync(workflowPath, "utf8");

test("Later canary preflight workflow stays manual and read-only", () => {
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /contents: read/);
  assert.match(source, /actions: read/);
  assert.match(source, /name: production-readonly-reconcile/);
  assert.match(source, /deployment: false/);

  assert.match(source, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(source, /secrets\.CLOUDFLARE_D1_READ_TOKEN/);
  assert.match(source, /secrets\.CONTROL_ACCESS_CLIENT_ID/);
  assert.match(source, /secrets\.CONTROL_ACCESS_CLIENT_SECRET/);
  assert.match(source, /rozkalns-control-github-readonly-reconcile/);
  assert.match(source, /rpi5-p1d-readonly-preflight/);

  assert.match(source, /\/api\/health/);
  assert.match(source, /\/api\/github\/dashboard/);
  assert.doesNotMatch(source, /\/api\/github\/later/);

  assert.equal((source.match(/-X POST/g) ?? []).length, 1);
  assert.match(
    source,
    /SELECT decision_id, schema_version, project_id, issue_number, pr_number, state_fingerprint, deferred_at FROM later_deferrals WHERE decision_id = \? LIMIT 2/,
  );
  assert.match(source, /params:\[\$decision_id\]/);
  assert.match(source, /meta\.changed_db/);
  assert.match(source, /meta\.rows_written/);
  assert.match(source, /meta\.changes/);

  assert.doesNotMatch(source, /wrangler\s+(deploy|versions\s+upload|versions\s+deploy|d1\s+migrations\s+apply)/i);
  assert.doesNotMatch(source, /curl[^\n]*-X\s+(PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(source, /gh\s+(pr\s+merge|run\s+rerun|run\s+cancel)/i);
  assert.match(source, /LATER_POST_SENT=NO/);
  assert.match(source, /REMOTE_D1_MUTATION=NO/);
  assert.match(source, /WORKER_MUTATION=NO/);
  assert.match(source, /GITHUB_DECISION_MUTATION=NO/);
});

test("Later preflight binds current-main CI and exact operator-supplied Worker baseline", () => {
  assert.match(source, /GITHUB_REF_NAME:-.*main/);
  assert.match(source, /\.commit\.sha == \$sha/);
  assert.match(source, /event=push&branch=main&head_sha=\$\{run_sha\}/);
  assert.match(source, /conclusion == "success"/);
  assert.match(source, /EXPECTED_DEPLOYMENT: \$\{\{ inputs\.expected_deployment \}\}/);
  assert.match(source, /EXPECTED_VERSION: \$\{\{ inputs\.expected_version \}\}/);
  assert.match(source, /\.result\.deployments\[0\]\.id == \$deployment/);
  assert.match(source, /\.result\.deployments\[0\]\.versions \| length == 1/);
  assert.match(source, /\.percentage == 100/);
});

test("Later preflight independently revalidates the selected target and exact fingerprint contract", () => {
  assert.match(source, /TARGET_REPOSITORY: rozkalnsandris\/ops-workflows/);
  assert.match(source, /includes\('LATER'\)/);
  assert.match(source, /candidates\.length !== 1/);
  assert.match(source, /item\.currentHeadSha !== item\.expectedHeadSha/);
  assert.match(source, /item\.lastReconciledAt !== data\.generatedAt/);
  assert.match(source, /later-decision-v1/);
  assert.match(source, /0xcbf29ce484222325n/);
  assert.match(source, /0x100000001b3n/);
  assert.match(source, /0xffffffffffffffffn/);
  assert.match(source, /repos\/\$\{TARGET_REPOSITORY\}\/pulls\/\$\{pr_number\}/);
  assert.match(source, /repos\/\$\{TARGET_REPOSITORY\}\/branches\/main/);
  assert.match(source, /EXISTING_DEFERRAL_ROWS/);
  assert.match(source, /LATER_DEFERRAL_PRESTATE_NOT_EMPTY/);
});
