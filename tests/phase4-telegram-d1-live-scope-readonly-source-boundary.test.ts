import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(
    process.cwd(),
    ".github/workflows/phase4-telegram-d1-live-scope-readonly.yml",
  ),
  "utf8",
);

test("Telegram D1 LIVE-scope review is manual, main-only and read-only", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /issue_comment:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /environment:\s*production-readonly-reconcile/);
  assert.match(workflow, /WORKFLOW_EVENT_NOT_DISPATCH/);
  assert.match(workflow, /WORKFLOW_REF_NOT_MAIN/);

  assert.match(workflow, /DB_NAME:\s*rozkalns-control-production/);
  assert.match(
    workflow,
    /DB_ID:\s*8504e986-faf0-450c-bfb5-41b5dbf8be09/,
  );
  assert.match(workflow, /DB_JURISDICTION:\s*eu/);
  assert.match(workflow, /CLOUDFLARE_D1_READ_TOKEN/);
  assert.match(workflow, /MISSING_CLOUDFLARE_D1_READ_TOKEN/);
  assert.match(workflow, /STAGE=D1_NOTIFICATION_MIGRATION_EVIDENCE/);
  assert.match(workflow, /D1_RESOURCE_IDENTITY=VALID/);

  assert.match(workflow, /cf_d1_select\(\)/);
  assert.match(workflow, /\[\[ "\$sql" == SELECT\\ \* \]\]/);
  assert.match(workflow, /D1_QUERY_NOT_SELECT/);
  assert.match(workflow, /D1_QUERY_MULTISTATEMENT_FORBIDDEN/);
  assert.match(workflow, /-X POST/);
  assert.match(workflow, /\/d1\/database\/\$\{DB_ID\}\/query/);
  assert.match(workflow, /meta\.changed_db/);
  assert.match(workflow, /meta\.rows_written/);
  assert.match(workflow, /meta\.changes/);
  assert.match(workflow, /D1_SELECT_REPORTED_MUTATION_OR_FAILURE/);

  for (const migration of [
    "0003_notification_transitions.sql",
    "0004_notification_delivery_intents.sql",
    "0005_notification_delivery_attempts.sql",
    "0006_notification_delivery_dispatch_claims.sql",
  ]) {
    assert.match(workflow, new RegExp(migration.replaceAll(".", "\\.")));
  }

  for (const table of [
    "notification_transitions",
    "notification_delivery_intents",
    "notification_delivery_attempts",
    "notification_delivery_dispatch_claims",
  ]) {
    assert.match(workflow, new RegExp(table));
  }

  assert.match(
    workflow,
    /D1_NOTIFICATION_MIGRATIONS=PROVEN_0003_THROUGH_0006/,
  );
  assert.match(workflow, /D1_NOTIFICATION_TABLES=PRESENT/);
  assert.match(workflow, /D1_NOTIFICATION_ROW_COUNTS=EVIDENCE_ONLY/);

  assert.match(
    workflow,
    /DISPATCH_QUEUE_NAME:\s*rozkalns-control-notification-dispatch/,
  );
  assert.match(workflow, /STAGE=PAUSED_QUEUE_AND_BACKLOG_EVIDENCE/);
  assert.match(workflow, /\/queues\/\$\{queue_id\}"/);
  assert.match(workflow, /delivery_paused == true/);
  assert.match(workflow, /DISPATCH_QUEUE_NOT_PAUSED/);
  assert.match(workflow, /\/queues\/\$\{queue_id\}\/metrics/);
  assert.match(workflow, /backlog_count/);
  assert.match(workflow, /backlog_bytes/);
  assert.match(workflow, /oldest_message_timestamp_ms/);
  assert.match(workflow, /DISPATCH_QUEUE_METRICS=BEST_EFFORT_POINT_IN_TIME/);
  assert.match(workflow, /GATE_B_ELIGIBILITY=BACKLOG_POLICY_REVIEW_REQUIRED/);
  assert.match(workflow, /GATE_B_ELIGIBILITY=SOURCE_EXECUTOR_REQUIRED/);

  assert.match(workflow, /EXPECTED_BATCH_SIZE:\s*'10'/);
  assert.match(workflow, /EXPECTED_BATCH_TIMEOUT_MS:\s*'5000'/);
  assert.match(workflow, /EXPECTED_MAX_RETRIES:\s*'3'/);
  assert.match(workflow, /EXPECTED_RETRY_DELAY:\s*'60'/);
  assert.match(workflow, /EXPECTED_MAX_CONCURRENCY:\s*'1'/);
  assert.match(
    workflow,
    /\(\(\.result\[0\]\.script_name == null\) or \(\.result\[0\]\.script_name == \$worker\)\)/,
  );

  assert.match(workflow, /STAGE=GITHUB_EXACT_MAIN_CI/);
  assert.match(workflow, /EXACT_MAIN_CI_NOT_SUCCESS/);
  assert.match(workflow, /EXACT_MAIN_CI_DRIFT/);
  assert.match(workflow, /STAGE=FINAL_ANTI_DRIFT/);
  assert.match(workflow, /FINAL_MAIN_SHA_DRIFT/);
  assert.match(workflow, /FINAL_PRODUCTION_BASELINE_DRIFT/);
  assert.match(workflow, /FINAL_QUEUE_PAUSE_DRIFT/);

  assert.match(workflow, /GATE_A_REPLAY=FORBIDDEN/);
  assert.match(workflow, /D1_MUTATION_MAX=0/);
  assert.match(workflow, /QUEUE_CREATE_MUTATION_MAX=0/);
  assert.match(workflow, /QUEUE_PAUSE_MUTATION_MAX=0/);
  assert.match(workflow, /QUEUE_CONSUMER_MUTATION_MAX=0/);
  assert.match(workflow, /SECRET_BINDING_MUTATION_MAX=0/);
  assert.match(workflow, /WORKER_VERSION_UPLOAD_MAX=0/);
  assert.match(workflow, /WORKER_DEPLOYMENT_WRITE_MAX=0/);
  assert.match(workflow, /PROVIDER_DELIVERY_RESUME_MUTATION_MAX=1/);
  assert.match(workflow, /DIRECT_TELEGRAM_API_REQUEST_MAX=0/);
  assert.match(
    workflow,
    /PROVIDER_RESUME_PRECONDITION=FRESH_QUEUE_PAUSED_AND_BACKLOG_RECHECK_REQUIRED/,
  );
  assert.match(workflow, /GATE_B_EXECUTOR=NOT_PRESENT_REVIEW_REQUIRED/);
  assert.match(workflow, /LIVE_AUTHORIZATION=NOT_GRANTED/);
  assert.match(
    workflow,
    /NEXT_GATE=SOURCE_GATE_B_EXECUTOR_AND_SEPARATE_LIVE_AUTHORIZATION/,
  );

  assert.match(workflow, /TELEGRAM_PROVIDER_REQUEST=NO/);
  assert.match(workflow, /QUEUE_MUTATION=NO/);
  assert.match(workflow, /REMOTE_D1_MUTATION=NO/);
  assert.match(workflow, /WORKER_MUTATION=NO/);
  assert.match(workflow, /CLOUDFLARE_CONFIG_MUTATION=NO/);
  assert.match(workflow, /SECRET_MUTATION=NO/);
  assert.match(workflow, /CLOUDFLARE_MUTATION=NO/);

  assert.doesNotMatch(workflow, /api\.telegram\.org/);
  assert.doesNotMatch(workflow, /sendMessage/);
  assert.doesNotMatch(workflow, /wrangler\s+(?:deploy|versions|d1|queues?)/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /\/messages\/purge/);
  assert.doesNotMatch(workflow, /\/purge(?:\?|\s|\x22)/);
});
