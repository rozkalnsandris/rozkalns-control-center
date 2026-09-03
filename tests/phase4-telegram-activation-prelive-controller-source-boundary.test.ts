import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/phase4-telegram-activation-prelive-controller.yml"),
  "utf8",
);
const workerLive = readFileSync(
  resolve(process.cwd(), ".github/workflows/production-worker-composite-live.yml"),
  "utf8",
);

test("Telegram pre-LIVE controller is exact-main, read-only and inventory-first", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /approved_sha:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /environment:\s*production-readonly-reconcile/);
  assert.match(workflow, /WORKFLOW_REF_NOT_MAIN/);
  assert.match(workflow, /WORKFLOW_SHA_NOT_APPROVED_SHA/);
  assert.match(workflow, /CHECKOUT_SHA_NOT_APPROVED_SHA/);
  assert.match(workflow, /EXACT_MAIN_CI_NOT_SUCCESS/);
  assert.match(workflow, /FINAL_MAIN_SHA_DRIFT/);
  assert.match(workflow, /FINAL_PRODUCTION_BASELINE_DRIFT/);

  const workerInventory = workflow.indexOf("STAGE=WORKER_ACTIVATION_PREREQUISITE_INVENTORY");
  const queueInventory = workflow.indexOf("STAGE=INDEPENDENT_QUEUE_INVENTORY");
  const finalDrift = workflow.indexOf("STAGE=FINAL_ANTI_DRIFT");
  assert.ok(workerInventory >= 0);
  assert.ok(queueInventory > workerInventory);
  assert.ok(finalDrift > queueInventory);
  assert.doesNotMatch(workflow, /\[\[ "\$binding_failures" == 0 \]\]/);
  assert.doesNotMatch(workflow, /NOTIFICATION_ACTIVATION_BINDINGS_INCOMPLETE/);

  assert.match(workflow, /\/queues\?per_page=100&page=1/);
  assert.match(workflow, /\/queues\/\$\{queue_id\}"/);
  assert.match(workflow, /\/queues\/\$\{queue_id\}\/consumers/);
  assert.match(workflow, /\/queues\/\$\{queue_id\}\/metrics/);
  assert.match(workflow, /DISPATCH_QUEUE=ABSENT/);
  assert.match(workflow, /DISPATCH_QUEUE=PRESENT/);
  assert.match(workflow, /DISPATCH_QUEUE_DELIVERY=%s/);
  assert.match(workflow, /DISPATCH_QUEUE_RUNTIME_PRODUCER=ABSENT/);
  assert.match(workflow, /DISPATCH_QUEUE_RUNTIME_PRODUCER=PRESENT_EXPECTED/);
  assert.match(workflow, /DISPATCH_QUEUE_RUNTIME_PRODUCER=DRIFTED/);
  assert.match(workflow, /DISPATCH_QUEUE_CONSUMER=%s/);
  assert.match(workflow, /PRESENT_EXPECTED/);
  assert.match(workflow, /DRIFTED/);
  assert.match(workflow, /DISPATCH_QUEUE_BACKLOG_COUNT=%s/);
  assert.match(workflow, /DISPATCH_QUEUE_BACKLOG_BYTES=%s/);
  assert.match(workflow, /DISPATCH_QUEUE_OLDEST_MESSAGE_TIMESTAMP_MS=%s/);
  assert.match(workflow, /DISPATCH_QUEUE_METRICS=BEST_EFFORT_POINT_IN_TIME/);

  assert.match(workflow, /D1_NOTIFICATION_MIGRATIONS=NOT_PROVEN_GET_ONLY/);
  assert.match(workflow, /D1_MUTATION_MAX=0_UNTIL_SEPARATE_REVIEW/);
  assert.match(workflow, /QUEUE_CREATE_MUTATION_COUNT=%s/);
  assert.match(workflow, /QUEUE_PAUSE_MUTATION_COUNT=%s/);
  assert.match(workflow, /QUEUE_CONSUMER_MUTATION_COUNT=%s/);
  assert.match(workflow, /QUEUE_PRE_PROVIDER_MUTATION_MAX=3/);
  assert.match(workflow, /SECRET_BINDING_MUTATION_MAX=2/);
  assert.match(workflow, /WORKER_VERSION_UPLOAD_MAX=1/);
  assert.match(workflow, /WORKER_DEPLOYMENT_WRITE_MAX=2/);
  assert.match(workflow, /WORKER_CANDIDATE_NORMAL_TRAFFIC_PERCENT=0/);
  assert.match(workflow, /WORKER_PROMOTION_TRAFFIC_PERCENT=100/);
  assert.match(workflow, /PROVIDER_DELIVERY_RESUME_MUTATION_COUNT=%s/);
  assert.match(workflow, /PROVIDER_API_REQUEST_MAX=0_UNTIL_SEPARATE_AUTHORIZATION/);
  assert.match(workflow, /NEXT_GATE=D1_MIGRATION_EVIDENCE_AND_SEPARATE_LIVE_SCOPE_REVIEW/);

  assert.match(workflow, /TELEGRAM_PROVIDER_REQUEST=NO/);
  assert.match(workflow, /QUEUE_MUTATION=NO/);
  assert.match(workflow, /REMOTE_D1_MUTATION=NO/);
  assert.match(workflow, /WORKER_MUTATION=NO/);
  assert.match(workflow, /SECRET_MUTATION=NO/);
  assert.match(workflow, /CLOUDFLARE_MUTATION=NO/);
  assert.match(workflow, /LIVE_AUTHORIZATION=NOT_GRANTED/);
  assert.doesNotMatch(workflow, /api\.telegram\.org/);
  assert.doesNotMatch(workflow, /sendMessage/);
  assert.doesNotMatch(workflow, /wrangler\s+(?:deploy|versions|d1|queues?|secret)/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /(?:^|\s)--request\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /\/messages\/(?:pull|ack|purge)/);
});

test("pre-LIVE envelope preserves the reviewed one-upload, zero-percent smoke, two-deployment Worker controller", () => {
  assert.match(workflow, /WORKER_ROLLOUT_CONTROLLER=\.github\/workflows\/production-worker-composite-live\.yml/);
  assert.match(workerLive, /UPLOAD1:DEPLOY2/);
  assert.match(workerLive, /wrangler versions upload/);
  assert.match(workerLive, /\$\{EXPECTED_VERSION\}@100%/);
  assert.match(workerLive, /\$\{candidate_version\}@0%/);
  assert.match(workerLive, /Cloudflare-Workers-Version-Overrides/);
  assert.match(workerLive, /\$\{candidate_version\}@100%/);
  assert.match(workerLive, /AUTOMATIC_RETRY=NO/);
  assert.match(workerLive, /AUTOMATIC_ROLLBACK=NO/);
  assert.match(workerLive, /AUTOMATIC_CLEANUP=NO/);
});
