import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/phase3-needs-changes-readonly-preflight.yml"),
  "utf8",
);

test("Phase 247 preflight is manual, parameterized and read-only", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /expected_worker_version:/);
  assert.match(workflow, /expected_deployment_id:/);
  assert.match(workflow, /target_main_sha:/);
  assert.match(workflow, /target_head_sha:/);
  assert.match(workflow, /target_ci_run_id:/);
  assert.match(workflow, /request_id:/);

  assert.match(workflow, /permissions:\n  contents: read\n  actions: read/);
  assert.match(workflow, /environment:\s*production-readonly-reconcile/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);

  assert.match(workflow, /TARGET_REPO: rozkalnsandris\/ops-workflows/);
  assert.match(workflow, /TARGET_ISSUE: "4"/);
  assert.match(workflow, /TARGET_PULL: "3"/);
  assert.match(workflow, /CONTROL_PANEL_REVIEW_CANARY\.md/);
  assert.match(workflow, /CONTROL_EXACT_MAIN_CI_NOT_SUCCESS/);
  assert.match(workflow, /TARGET_EXACT_HEAD_CI_NOT_SUCCESS/);
  assert.match(workflow, /PRODUCTION_BASELINE_DRIFT/);
  assert.match(workflow, /HEALTH_IDENTITY_DRIFT/);
  assert.match(workflow, /NEEDS_CHANGES_PREFLIGHT_NOT_READY/);
  assert.match(workflow, /\.decision\.ci == "PASS"/);
  assert.match(workflow, /\.decision\.review == "NOT_REQUIRED"/);
  assert.match(workflow, /\.decision\.workflowState == "MERGE_READY"/);
  assert.match(workflow, /FINAL_PRODUCTION_BASELINE_DRIFT/);

  assert.match(
    workflow,
    /SELECT request_id FROM needs_changes_decisions WHERE request_id = \? LIMIT 1/,
  );
  assert.match(
    workflow,
    /\/d1\/database\/\$\{DB_ID\}\/query/,
  );
  assert.equal((workflow.match(/--request POST/g) ?? []).length, 1);
  assert.doesNotMatch(
    workflow,
    /\/api\/github\/needs-changes(?:[?'"\s]|$)/,
  );
  assert.doesNotMatch(
    workflow,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE)\b/i,
  );

  assert.match(workflow, /PHASE247_READONLY_PREFLIGHT=PASS/);
  assert.match(workflow, /D1_REQUEST_ID_ROWS=0/);
  assert.match(workflow, /GITHUB_MUTATION=NO/);
  assert.match(workflow, /CLOUDFLARE_MUTATION=NO/);
  assert.match(workflow, /D1_MUTATION=NO/);
  assert.match(workflow, /NEEDS_CHANGES_POST=NOT_CALLED/);
  assert.match(workflow, /REQUEST_CHANGES_AUTHORIZATION=NOT_GRANTED/);

  assert.doesNotMatch(workflow, /\bwrangler\s+(?:deploy|versions|rollback|delete|d1 migrations)/);
  assert.doesNotMatch(workflow, /\bgh\s+pr\s+(?:merge|review)/);
  assert.doesNotMatch(workflow, /\bgit\s+(?:push|merge|reset|rebase|clean)/);
  assert.doesNotMatch(workflow, /curl[^\n]*--retry/);
  assert.doesNotMatch(workflow, /\brm\s+-rf\b/);

  // Historical canary/request identities must never be baked into the reusable preflight.
  assert.doesNotMatch(workflow, /b1b762d91ebe86aa7f0253dcf47ce456eb11d984/);
  assert.doesNotMatch(workflow, /eb38a1244fa2af1b91945c996215a4c105d73d26/);
  assert.doesNotMatch(workflow, /phase3_ops_pr3_issue4_20260824T0955_3e69/);
  assert.doesNotMatch(workflow, /phase3_ops_pr3_issue4_20260825T0027_b1b7/);
});