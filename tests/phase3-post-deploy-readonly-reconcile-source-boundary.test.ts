import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/phase3-post-deploy-readonly-reconcile-255.yml"),
  "utf8",
);

test("Phase 3 production reconciliation stays manual, exact-baseline, and read-only", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /environment:\s*production-readonly-reconcile/);

  assert.match(workflow, /EXPECTED_NEW_VERSION:\s*83eb326a-3a0e-4548-b253-7a463bc934ac/);
  assert.match(workflow, /EXPECTED_NEW_DEPLOYMENT:\s*9392d84b-5458-4b33-9dda-9918a8d535d4/);
  assert.match(workflow, /current_deployment.*EXPECTED_NEW_DEPLOYMENT/);
  assert.match(workflow, /current_version.*EXPECTED_NEW_VERSION/);
  assert.match(workflow, /ACTIVE_DEPLOYMENT_NOT_SINGLE_VERSION_100_PERCENT/);

  assert.match(workflow, /MAIN_SHA_DRIFT/);
  assert.match(workflow, /event=push&branch=main&head_sha=\$\{run_sha\}/);
  assert.match(workflow, /EXACT_MAIN_CI_NOT_SUCCESS/);
  assert.match(workflow, /EXACT_MAIN_CI_DRIFT/);

  assert.match(workflow, /access_get '\/api\/health'/);
  assert.match(workflow, /access_get '\/api\/github\/dashboard'/);
  assert.match(workflow, /\/api\/github\/needs-changes\/preflight\?/);
  assert.match(workflow, /NEEDS_CHANGES_POST=NOT_CALLED/);
  assert.match(workflow, /CLOUDFLARE_MUTATION=NO/);

  assert.doesNotMatch(workflow, /wrangler\s+deploy/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /(?:^|\s)--request\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /access_(?:post|put|patch|delete)\s*\(/i);
});
