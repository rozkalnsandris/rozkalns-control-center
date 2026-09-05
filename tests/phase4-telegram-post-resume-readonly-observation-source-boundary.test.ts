import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(
    process.cwd(),
    ".github/workflows/phase4-telegram-post-resume-readonly-observation.yml",
  ),
  "utf8",
);

test("Telegram post-resume observer is manual, main-only and read-only", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment:\s*production-readonly-reconcile/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /WORKFLOW_EVENT_NOT_DISPATCH/);
  assert.match(workflow, /WORKFLOW_REF_NOT_MAIN/);

  for (const input of [
    "expected_gate_b_run",
    "expected_deployment",
    "expected_version",
    "expected_queue_id",
    "expected_consumer_id",
    "expected_pre_resume_intents",
  ]) {
    assert.match(workflow, new RegExp(input));
  }

  assert.match(workflow, /Phase 4 Telegram Gate B provider delivery resume/);
  assert.match(workflow, /phase4-telegram-gate-b-live\.yml/);
  assert.match(workflow, /\.run_attempt == 1/);
  assert.match(workflow, /\.conclusion == "success"/);
  assert.match(workflow, /GATE_B_RUN_INVALID/);
  assert.match(workflow, /GATE_B_START_TIME_INVALID/);

  assert.match(workflow, /CLOUDFLARE_D1_READ_TOKEN/);
  assert.match(workflow, /cf_d1_select\(\)/);
  assert.match(workflow, /\[\[ "\$sql" == SELECT\\ \* \]\]/);
  assert.match(workflow, /D1_QUERY_NOT_SELECT/);
  assert.match(workflow, /D1_QUERY_MULTISTATEMENT_FORBIDDEN/);
  assert.match(workflow, /meta\.changed_db/);
  assert.match(workflow, /meta\.rows_written/);
  assert.match(workflow, /meta\.changes/);
  assert.match(workflow, /D1_SELECT_REPORTED_MUTATION_OR_FAILURE/);

  assert.match(workflow, /STAGE=D1_POST_RESUME_DELIVERY_EVIDENCE/);
  assert.match(workflow, /notification_delivery_intents/);
  assert.match(workflow, /notification_delivery_attempts/);
  assert.match(workflow, /notification_delivery_dispatch_claims/);
  assert.match(workflow, /ATTEMPT_CLAIM_COUNT_MISMATCH/);
  assert.match(workflow, /ATTEMPT_WITHOUT_CLAIM/);
  assert.match(workflow, /CLAIM_WITHOUT_ATTEMPT/);
  assert.match(workflow, /GATE_B_DELIVERED_INTENTS/);
  assert.match(workflow, /GATE_B_TERMINAL_FAILURE_INTENTS/);
  assert.match(workflow, /GATE_B_EXHAUSTED_INTENTS/);
  assert.match(workflow, /GATE_B_UNSETTLED_INTENTS/);
  assert.match(workflow, /GATE_B_DELIVERY_NOT_SETTLED/);
  assert.match(workflow, /GATE_B_HISTORICAL_DELIVERY=SETTLED/);

  assert.match(workflow, /STAGE=RESUMED_QUEUE_OBSERVATION/);
  assert.match(workflow, /delivery_paused == false/);
  assert.match(workflow, /DISPATCH_QUEUE_NOT_RESUMED/);
  assert.match(workflow, /DISPATCH_QUEUE_CONSUMER_DRIFT/);
  assert.match(workflow, /backlog_count/);
  assert.match(workflow, /backlog_bytes/);
  assert.match(workflow, /oldest_message_timestamp_ms/);
  assert.match(workflow, /QUEUE_REPLAY_BACKLOG_DRAIN=COMPLETE/);
  assert.match(
    workflow,
    /QUEUE_REPLAY_BACKLOG_DRAIN=IN_PROGRESS_OR_NEW_WORK_PRESENT/,
  );

  assert.match(workflow, /STAGE=FINAL_ANTI_DRIFT/);
  assert.match(workflow, /FINAL_MAIN_SHA_DRIFT/);
  assert.match(workflow, /FINAL_PRODUCTION_BASELINE_DRIFT/);
  assert.match(workflow, /FINAL_QUEUE_RESUME_DRIFT/);
  assert.match(workflow, /PHASE4_TELEGRAM_POST_RESUME=OBSERVED_SETTLED/);
  assert.match(workflow, /GET_OR_SELECT_ONLY_OBSERVATION=PASS/);
  assert.match(workflow, /GATE_B_RERUN=FORBIDDEN/);
  assert.match(workflow, /LIVE_AUTHORIZATION=NOT_REQUIRED_READ_ONLY/);

  assert.match(workflow, /TELEGRAM_PROVIDER_REQUEST=NO/);
  assert.match(workflow, /QUEUE_MUTATION=NO/);
  assert.match(workflow, /REMOTE_D1_MUTATION=NO/);
  assert.match(workflow, /WORKER_MUTATION=NO/);
  assert.match(workflow, /SECRET_MUTATION=NO/);
  assert.match(workflow, /CLOUDFLARE_MUTATION=NO/);

  assert.doesNotMatch(workflow, /api\.telegram\.org/);
  assert.doesNotMatch(workflow, /sendMessage/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /wrangler\s+(?:deploy|versions|d1|queues?)/);
  assert.doesNotMatch(workflow, /\/messages\/(?:pull|peek|ack|purge)/);
});
