import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/production-worker-composite-live.yml"),
  "utf8",
);
const wrangler = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
const worker = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");

test("production Worker Composite Live workflow is manual, exact-bound and bounded", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /approved_sha:/);
  assert.match(workflow, /expected_version:/);
  assert.match(workflow, /expected_deployment:/);
  assert.match(workflow, /owner_authorization:/);
  assert.match(workflow, /environment:\s*production-worker-deploy/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /cancel-in-progress:\s*false/);

  assert.match(workflow, /WORKFLOW_REF_NOT_MAIN/);
  assert.match(workflow, /WORKFLOW_SHA_NOT_APPROVED_SHA/);
  assert.match(workflow, /WORKFLOW_RERUN_FORBIDDEN/);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT/);
  assert.match(workflow, /EXACT_MAIN_CI_NOT_SUCCESS/);
  assert.match(workflow, /PRODUCTION_BASELINE_DRIFT/);
  assert.match(workflow, /MAIN_SHA_DRIFT_BEFORE_WRITE/);
  assert.match(workflow, /OWNER_AUTHORIZATION_MISMATCH/);
  assert.match(workflow, /UPLOAD1:DEPLOY2/);

  assert.match(workflow, /wrangler versions upload/);
  assert.match(workflow, /--strict/);
  assert.match(workflow, /--experimental-provision=false/);
  assert.match(workflow, /--experimental-auto-create=false/);
  assert.match(workflow, /\$\{EXPECTED_VERSION\}@100%/);
  assert.match(workflow, /\$\{candidate_version\}@0%/);
  assert.match(workflow, /Cloudflare-Workers-Version-Overrides/);
  assert.match(workflow, /\.workerVersion == \$version/);
  assert.match(workflow, /EXACT_CANDIDATE_SMOKE_GET_FAILED/);
  assert.match(workflow, /EXACT_CANDIDATE_SMOKE_HTTP_NOT_200/);
  assert.match(workflow, /EXACT_CANDIDATE_SMOKE_IDENTITY_MISMATCH/);
  assert.match(workflow, /PREPROMOTION_DEPLOYMENT_DRIFT/);
  assert.match(workflow, /\$\{candidate_version\}@100%/);
  assert.match(workflow, /FINAL_HEALTH_VERSION_MISMATCH/);
  assert.match(workflow, /VERSION_UPLOAD_COUNT=/);
  assert.match(workflow, /DEPLOYMENT_WRITE_COUNT=/);

  assert.match(workflow, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(workflow, /AUTOMATIC_RETRY=NO/);
  assert.match(workflow, /AUTOMATIC_ROLLBACK=NO/);
  assert.match(workflow, /AUTOMATIC_CLEANUP=NO/);
  assert.match(workflow, /EVIDENCE_PRESERVED=YES/);
  assert.doesNotMatch(
    workflow,
    /^ {6}EVIDENCE_DIR:\s*\$\{\{\s*runner\.temp/m,
  );
  assert.match(
    workflow,
    /^ {10}EVIDENCE_DIR:\s*\$\{\{\s*runner\.temp\s*\}\}\/control-worker-composite-live-\$\{\{\s*github\.run_id\s*\}\}$/m,
  );
  assert.match(
    workflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
  );
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /receipt\.txt/);
  assert.doesNotMatch(workflow, /for\s+attempt\s+in/);
  assert.doesNotMatch(workflow, /curl[^\n]*--retry/);
  assert.doesNotMatch(workflow, /\brm\s+-rf\b/);
  assert.doesNotMatch(workflow, /wrangler\s+rollback/);
  assert.doesNotMatch(workflow, /wrangler\s+delete/);
  assert.doesNotMatch(workflow, /git\s+(?:reset|rebase|clean)/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /\/api\/github\/needs-changes(?:\s|["'])/);
});

test("Worker exposes exact Cloudflare version identity on no-store health", () => {
  assert.match(wrangler, /"version_metadata"\s*:\s*\{/);
  assert.match(wrangler, /"binding"\s*:\s*"CF_VERSION_METADATA"/);
  assert.match(worker, /buildHealthPayload\(env\.CF_VERSION_METADATA\.id\)/);
  assert.match(worker, /headers:\s*NO_STORE_HEADERS/);
});