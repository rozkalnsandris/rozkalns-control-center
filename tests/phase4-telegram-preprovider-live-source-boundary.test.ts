import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/phase4-telegram-preprovider-live.yml"),
  "utf8",
);

test("Telegram Gate A binds exact source, CI, preflight and production baseline", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /approved_sha:/);
  assert.match(workflow, /expected_version:/);
  assert.match(workflow, /expected_deployment:/);
  assert.match(workflow, /expected_ci_run:/);
  assert.match(workflow, /expected_preflight_run:/);
  assert.match(workflow, /owner_authorization:/);
  assert.match(workflow, /environment:\s*production-worker-deploy/);
  assert.match(workflow, /WORKFLOW_REF_NOT_MAIN/);
  assert.match(workflow, /WORKFLOW_SHA_NOT_APPROVED_SHA/);
  assert.match(workflow, /WORKFLOW_RERUN_FORBIDDEN/);
  assert.match(workflow, /EXACT_MAIN_CI_DRIFT/);
  assert.match(workflow, /PREFLIGHT_RUN_DRIFT/);
  assert.match(workflow, /PRODUCTION_BASELINE_DRIFT/);
  assert.match(workflow, /MAIN_SHA_DRIFT_BEFORE_WRITE/);
  assert.match(workflow, /DISPATCH_QUEUE_DRIFT_BEFORE_WRITE/);
});

test("Telegram Gate A keeps Queue paused and provider delivery explicitly outside scope", () => {
  const create = workflow.indexOf("STAGE=CREATE_DISPATCH_QUEUE");
  const pause = workflow.indexOf("STAGE=PAUSE_DISPATCH_QUEUE");
  const consumer = workflow.indexOf("STAGE=CREATE_DISPATCH_CONSUMER");
  const upload = workflow.indexOf("STAGE=UPLOAD_EXACT_CANDIDATE_WITH_TWO_SECRETS");
  const attach = workflow.indexOf("STAGE=CANDIDATE_ATTACH_ZERO_TRAFFIC");
  const smoke = workflow.indexOf("STAGE=EXACT_CANDIDATE_SMOKE");
  const promote = workflow.indexOf("STAGE=PROMOTE_EXACT_VERIFIED_CANDIDATE");
  const reconcile = workflow.indexOf("STAGE=POSTWRITE_READONLY_RECONCILIATION");

  assert.ok(create >= 0);
  assert.ok(pause > create);
  assert.ok(consumer > pause);
  assert.ok(upload > consumer);
  assert.ok(attach > upload);
  assert.ok(smoke > attach);
  assert.ok(promote > smoke);
  assert.ok(reconcile > promote);

  assert.match(workflow, /queue_create_count=1/);
  assert.match(workflow, /queue_pause_count=1/);
  assert.match(workflow, /queue_consumer_count=1/);
  assert.match(workflow, /delivery_paused\":true/);
  assert.match(workflow, /QUEUE_UNPAUSED_PREPROMOTION/);
  assert.match(workflow, /FINAL_QUEUE_NOT_PAUSED/);
  assert.match(workflow, /PROVIDER_RESUME_COUNT=0/);
  assert.match(workflow, /PROVIDER_API_REQUEST_COUNT=0/);
  assert.match(workflow, /NEXT_GATE=SEPARATE_PROVIDER_DELIVERY_RESUME_AUTHORIZATION/);
  assert.doesNotMatch(workflow, /resume-delivery/);
  assert.doesNotMatch(workflow, /api\.telegram\.org/);
  assert.doesNotMatch(workflow, /sendMessage/);
  assert.doesNotMatch(workflow, /wrangler\s+d1\s+migrations\s+apply/);
});

test("Telegram secrets are protected inputs on the single candidate version upload", () => {
  assert.match(workflow, /CONTROL_TELEGRAM_BOT_TOKEN:\s*\$\{\{ secrets\.CONTROL_TELEGRAM_BOT_TOKEN \}\}/);
  assert.match(workflow, /CONTROL_TELEGRAM_CHAT_ID:\s*\$\{\{ secrets\.CONTROL_TELEGRAM_CHAT_ID \}\}/);
  assert.match(workflow, /--secrets-file "\$secrets_file"/);
  assert.match(workflow, /wrangler versions upload/);
  assert.match(workflow, /--strict/);
  assert.match(workflow, /--experimental-provision=false/);
  assert.match(workflow, /--experimental-auto-create=false/);
  assert.match(workflow, /secret_binding_count=2/);
  assert.match(workflow, /version_upload_count=1/);
  assert.doesNotMatch(workflow, /wrangler secret put/);
  assert.doesNotMatch(workflow, /wrangler versions secret put/);
  assert.doesNotMatch(workflow, /printf[^\n]*CONTROL_TELEGRAM_(?:BOT_TOKEN|CHAT_ID)/);
});

test("Telegram Gate A preserves exact zero-percent smoke and one-shot failure semantics", () => {
  assert.match(workflow, /\$\{EXPECTED_VERSION\}@100%/);
  assert.match(workflow, /\$\{candidate_version\}@0%/);
  assert.match(workflow, /Cloudflare-Workers-Version-Overrides/);
  assert.match(workflow, /\$\{candidate_version\}@100%/);
  assert.match(workflow, /VERSION_UPLOAD_COUNT=%s/);
  assert.match(workflow, /DEPLOYMENT_WRITE_COUNT=%s/);
  assert.match(workflow, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(workflow, /AUTOMATIC_RETRY=NO/);
  assert.match(workflow, /AUTOMATIC_ROLLBACK=NO/);
  assert.match(workflow, /AUTOMATIC_CLEANUP=NO/);
  assert.doesNotMatch(workflow, /wrangler\s+rollback/);
  assert.doesNotMatch(workflow, /queues\s+purge/);
  assert.doesNotMatch(workflow, /queues\s+delete/);
});
