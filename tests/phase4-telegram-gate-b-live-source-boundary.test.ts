import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/phase4-telegram-gate-b-live.yml"),
  "utf8",
);
const doc = readFileSync(
  resolve(process.cwd(), "docs/PHASE4_TELEGRAM_GATE_B_LIVE.md"),
  "utf8",
);

test("Gate B is manual, exact-main, one-shot and bound to fresh evidence", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /issue_comment:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /environment:\s*production-worker-deploy/);
  assert.match(workflow, /WORKFLOW_EVENT_NOT_DISPATCH/);
  assert.match(workflow, /WORKFLOW_REF_NOT_MAIN/);
  assert.match(workflow, /WORKFLOW_SHA_NOT_APPROVED_SHA/);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT/);
  assert.match(workflow, /WORKFLOW_RERUN_FORBIDDEN/);

  for (const input of [
    "approved_sha",
    "expected_ci_run",
    "expected_readonly_run",
    "expected_deployment",
    "expected_version",
    "expected_queue_id",
    "expected_consumer_id",
    "expected_transition_rows",
    "expected_intent_rows",
    "expected_backlog_count",
    "expected_backlog_bytes",
    "owner_authorization",
  ]) {
    assert.match(workflow, new RegExp(`${input}:`));
  }

  assert.match(workflow, /\/actions\/runs\/\$\{EXPECTED_CI_RUN\}/);
  assert.match(workflow, /EXACT_MAIN_CI_DRIFT/);
  assert.match(workflow, /\/actions\/runs\/\$\{EXPECTED_READONLY_RUN\}/);
  assert.match(workflow, /Phase 4 Telegram D1 and LIVE scope read-only review/);
  assert.match(workflow, /phase4-telegram-d1-live-scope-readonly\.yml/);
  assert.match(workflow, /READONLY_RUN_DRIFT/);
});

test("Gate B requires pristine D1 replay evidence and exact reviewed runtime", () => {
  assert.match(workflow, /DB_NAME:\s*rozkalns-control-production/);
  assert.match(workflow, /DB_ID:\s*8504e986-faf0-450c-bfb5-41b5dbf8be09/);
  assert.match(workflow, /DB_JURISDICTION:\s*eu/);
  assert.match(workflow, /CLOUDFLARE_D1_READ_TOKEN/);
  assert.match(workflow, /D1_QUERY_NOT_SELECT/);
  assert.match(workflow, /D1_QUERY_MULTISTATEMENT_FORBIDDEN/);
  assert.match(workflow, /meta\.changed_db/);
  assert.match(workflow, /meta\.rows_written/);
  assert.match(workflow, /meta\.changes/);

  for (const migration of [
    "0003_notification_transitions.sql",
    "0004_notification_delivery_intents.sql",
    "0005_notification_delivery_attempts.sql",
    "0006_notification_delivery_dispatch_claims.sql",
  ]) {
    assert.match(workflow, new RegExp(migration.replaceAll(".", "\\.")));
  }

  assert.match(workflow, /EXPECTED_D1_CARDINALITY_MISMATCH/);
  assert.match(workflow, /D1_ATTEMPTS_NOT_PRISTINE/);
  assert.match(workflow, /D1_CLAIMS_NOT_PRISTINE/);
  assert.match(workflow, /D1_PREPROVIDER_STATE=PRISTINE/);
  assert.match(workflow, /verify_d1_counts "\$tmp\/counts-prewrite\.json" FINAL_PREWRITE/);

  assert.match(workflow, /CONTROL_NOTIFICATION_TRANSITIONS_ENABLED/);
  assert.match(workflow, /CONTROL_NOTIFICATION_DISPATCH_ENABLED/);
  assert.match(workflow, /CONTROL_NOTIFICATION_RETRY_POLICY/);
  assert.match(workflow, /CONTROL_TELEGRAM_BOT_TOKEN/);
  assert.match(workflow, /CONTROL_TELEGRAM_CHAT_ID/);
  assert.match(workflow, /NOTIFICATION_DISPATCH_QUEUE/);
  assert.match(workflow, /EXPECTED_BATCH_SIZE:\s*'10'/);
  assert.match(workflow, /EXPECTED_BATCH_TIMEOUT_MS:\s*'5000'/);
  assert.match(workflow, /EXPECTED_MAX_RETRIES:\s*'3'/);
  assert.match(workflow, /EXPECTED_RETRY_DELAY:\s*'60'/);
  assert.match(workflow, /EXPECTED_MAX_CONCURRENCY:\s*'1'/);
  assert.match(workflow, /DISPATCH_QUEUE_CONSUMER_DRIFT/);
});

test("Gate B binds the paused backlog but never treats backlog count as send authority", () => {
  assert.match(workflow, /BACKLOG_POLICY:\s*REPLAY_SAFE_DURABLE_INTENT_DRAIN/);
  assert.match(workflow, /EXPECTED_BACKLOG_COUNT/);
  assert.match(workflow, /EXPECTED_BACKLOG_BYTES/);
  assert.match(workflow, /BACKLOG_COUNT_DRIFT/);
  assert.match(workflow, /BACKLOG_BYTES_DRIFT/);
  assert.match(workflow, /oldest_message_timestamp_ms/);
  assert.match(workflow, /BACKLOG_COUNT_IS_PROVIDER_SEND_AUTHORITY=NO/);
  assert.match(workflow, /FINAL_PREWRITE_REVALIDATION/);

  const finalMetrics = workflow.indexOf(
    'cf_get "/queues/${EXPECTED_QUEUE_ID}/metrics" "$tmp/metrics-prewrite.json"',
  );
  const mutation = workflow.indexOf(
    'cf_write_json PATCH "/queues/${EXPECTED_QUEUE_ID}"',
  );
  assert.ok(finalMetrics >= 0);
  assert.ok(mutation > finalMetrics);

  assert.match(doc, /REPLAY_SAFE_DURABLE_INTENT_DRAIN/);
  assert.match(doc, /1211/);
  assert.match(doc, /does not mean 1211 Telegram sends/i);
  assert.match(doc, /oldest-message.*unknown/i);
  assert.match(doc, /fresh .*read-only run/i);
});

test("Gate B exposes exactly one Queue resume write and fails closed after it starts", () => {
  const writeCalls = workflow.match(/^\s*cf_write_json\s+(?:PATCH|POST|PUT|DELETE)\b/gm) ?? [];
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0], /cf_write_json\s+PATCH/);
  assert.match(
    workflow,
    /cf_write_json PATCH "\/queues\/\$\{EXPECTED_QUEUE_ID\}" '\{"settings":\{"delivery_paused":false\}\}'/,
  );
  assert.match(workflow, /mutation_started=YES/);
  assert.match(workflow, /queue_resume_count=1/);
  assert.match(workflow, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(workflow, /AUTOMATIC_RETRY=NO/);
  assert.match(workflow, /AUTOMATIC_ROLLBACK=NO/);
  assert.match(workflow, /AUTOMATIC_CLEANUP=NO/);
  assert.match(workflow, /POST_RESUME_QUEUE_STATE_UNCONFIRMED/);
  assert.match(workflow, /QUEUE_CONSUMER_PROVIDER_DELIVERY=MAY_BEGIN_AFTER_RESUME/);
  assert.match(workflow, /POST_RESUME_D1_PRISTINE_CHECK=NOT_APPLICABLE_PROVIDER_MAY_BE_ACTIVE/);

  assert.match(workflow, /D1_MUTATION_COUNT=0/);
  assert.match(workflow, /QUEUE_CREATE_COUNT=0/);
  assert.match(workflow, /QUEUE_PAUSE_COUNT=0/);
  assert.match(workflow, /QUEUE_CONSUMER_MUTATION_COUNT=0/);
  assert.match(workflow, /WORKER_VERSION_UPLOAD_COUNT=0/);
  assert.match(workflow, /WORKER_DEPLOYMENT_WRITE_COUNT=0/);
  assert.match(workflow, /SECRET_MUTATION_COUNT=0/);
  assert.match(workflow, /DIRECT_TELEGRAM_API_REQUEST_COUNT=0/);
});

test("Gate B authorization is exact and forbidden mutation families stay absent", () => {
  assert.match(workflow, /OWNER_AUTHORIZATION_MISMATCH/);
  assert.match(workflow, /AUTHORIZE PHASE4 TELEGRAM GATE B LIVE/);
  assert.match(workflow, /D1 TRANSITIONS \$\{EXPECTED_TRANSITION_ROWS\} INTENTS \$\{EXPECTED_INTENT_ROWS\} ATTEMPTS 0 CLAIMS 0/);
  assert.match(workflow, /BACKLOG \$\{EXPECTED_BACKLOG_COUNT\} MESSAGES \$\{EXPECTED_BACKLOG_BYTES\} BYTES/);
  assert.match(workflow, /POLICY \$\{BACKLOG_POLICY\}/);
  assert.match(workflow, /QUEUE RESUME 1/);
  assert.match(workflow, /DIRECT TELEGRAM REQUEST 0/);
  assert.match(workflow, /NO RETRY/);
  assert.match(workflow, /NO ROLLBACK/);
  assert.match(workflow, /NO CLEANUP/);

  assert.doesNotMatch(workflow, /api\.telegram\.org/);
  assert.doesNotMatch(workflow, /sendMessage/);
  assert.doesNotMatch(workflow, /wrangler\s+(?:deploy|versions|d1|queues?)/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:PUT|DELETE)\b/m);
  assert.doesNotMatch(workflow, /\/messages\/(?:pull|ack|purge)/);
  assert.doesNotMatch(workflow, /\/purge(?:\?|\s|\x22)/);
  assert.doesNotMatch(workflow, /secret\s+(?:put|delete|bulk)/i);

  assert.match(doc, /one Queue `delivery_paused=false` PATCH/i);
  assert.match(doc, /no automatic retry, rollback or production cleanup/i);
  assert.match(doc, /future live intents/i);
});
