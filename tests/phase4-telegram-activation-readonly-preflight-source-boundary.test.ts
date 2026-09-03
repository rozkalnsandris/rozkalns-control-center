import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(
    process.cwd(),
    ".github/workflows/phase4-telegram-activation-readonly-preflight.yml",
  ),
  "utf8",
);

test("Telegram activation preflight is manual, main-only, and read-only", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /issue_comment:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /environment:\s*production-readonly-reconcile/);
  assert.match(workflow, /WORKFLOW_EVENT_NOT_DISPATCH/);
  assert.match(workflow, /WORKFLOW_REF_NOT_MAIN/);

  assert.match(workflow, /STAGE=GITHUB_EXACT_MAIN_CI/);
  assert.match(workflow, /event=push&branch=main&head_sha=\$\{run_sha\}/);
  assert.match(workflow, /EXACT_MAIN_CI_NOT_SUCCESS/);
  assert.match(workflow, /EXACT_MAIN_CI_DRIFT/);
  assert.match(workflow, /STAGE=FINAL_ANTI_DRIFT/);
  assert.match(workflow, /FINAL_MAIN_SHA_DRIFT/);

  assert.match(workflow, /DISPATCH_QUEUE_NAME:\s*rozkalns-control-notification-dispatch/);
  assert.match(workflow, /CONTROL_ORIGIN:\s*https:\/\/control\.rozkalns\.net/);
  assert.match(workflow, /EXPECTED_TARGET_KEY:\s*primary/);
  assert.match(
    workflow,
    /EXPECTED_RETRY_POLICY_JSON:\s*'\{"schemaVersion":1,"maxAttempts":2,"retryDelaysSeconds":\[60\]\}'/,
  );
  assert.match(workflow, /\/workers\/scripts\/\$\{WORKER_NAME\}\/deployments/);
  assert.match(workflow, /\/workers\/scripts\/\$\{WORKER_NAME\}\/versions\/\$\{current_version\}/);
  assert.match(workflow, /\/queues\?per_page=100&page=1/);
  assert.match(workflow, /\/queues\/\$\{queue_id\}\/consumers/);
  assert.match(workflow, /ACTIVE_DEPLOYMENT_NOT_SINGLE_VERSION_100_PERCENT/);
  assert.match(workflow, /QUEUE_INVENTORY_PAGINATION_AMBIGUOUS/);
  assert.match(workflow, /DISPATCH_QUEUE_NOT_UNIQUE/);
  assert.match(workflow, /DISPATCH_QUEUE_WORKER_CONSUMER_NOT_UNIQUE/);
  assert.match(workflow, /DISPATCH_QUEUE_CONSUMER_POLICY_INCOMPATIBLE/);

  assert.match(
    workflow,
    /LC_ALL=C tr -cd '\[:alnum:\] _\.\/:@,\+\{\}\\\[\\\]"-'/,
  );
  assert.doesNotMatch(workflow, /tr -cd '[^\n]*_- /);
  assert.match(workflow, /CURRENT_DEPLOYMENT=%s/);
  assert.match(workflow, /CURRENT_VERSION=%s/);

  assert.match(workflow, /CONTROL_NOTIFICATION_TRANSITIONS_ENABLED/);
  assert.match(workflow, /CONTROL_NOTIFICATION_DISPATCH_ENABLED/);
  assert.match(workflow, /CONTROL_NOTIFICATION_TARGET_KEYS/);
  assert.match(workflow, /CONTROL_NOTIFICATION_RETRY_POLICY/);
  assert.match(workflow, /CONTROL_TELEGRAM_TARGET_KEY/);
  assert.match(workflow, /CONTROL_TELEGRAM_BOT_TOKEN/);
  assert.match(workflow, /CONTROL_TELEGRAM_CHAT_ID/);
  assert.match(workflow, /CONTROL_NOTIFICATION_CONTROL_ORIGIN/);
  assert.match(workflow, /NOTIFICATION_DISPATCH_QUEUE/);

  assert.match(workflow, /--arg target "\$EXPECTED_TARGET_KEY"/);
  assert.match(workflow, /\(\$targets == \[\$target\]\)/);
  assert.match(workflow, /\(\$targetBinding\.text == \$target\)/);
  assert.match(workflow, /--arg expected "\$EXPECTED_RETRY_POLICY_JSON"/);
  assert.match(workflow, /\(\$expected \| fromjson\) as \$expectedRetry/);
  assert.match(workflow, /\(\$retry == \$expectedRetry\)/);

  assert.match(workflow, /TRANSITION_OPT_IN=MISSING/);
  assert.match(workflow, /TRANSITION_OPT_IN=ENABLED/);
  assert.match(workflow, /TRANSITION_OPT_IN=INVALID/);
  assert.match(workflow, /DISPATCH_OPT_IN=MISSING/);
  assert.match(workflow, /DISPATCH_OPT_IN=ENABLED/);
  assert.match(workflow, /DISPATCH_OPT_IN=INVALID/);
  assert.match(workflow, /TARGET_CONTRACT=MISSING/);
  assert.match(workflow, /TARGET_CONTRACT=VALID_SINGLE_TELEGRAM_TARGET/);
  assert.match(workflow, /TARGET_CONTRACT=INVALID/);
  assert.match(workflow, /TARGET_KEY=%s/);
  assert.match(workflow, /RETRY_POLICY=MISSING/);
  assert.match(workflow, /RETRY_POLICY=VALID/);
  assert.match(workflow, /RETRY_POLICY=INVALID/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN_BINDING=MISSING/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN_BINDING=PRESENT_SECRET/);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN_BINDING=INVALID/);
  assert.match(workflow, /TELEGRAM_CHAT_ID_BINDING=MISSING/);
  assert.match(workflow, /TELEGRAM_CHAT_ID_BINDING=PRESENT_SECRET/);
  assert.match(workflow, /TELEGRAM_CHAT_ID_BINDING=INVALID/);
  assert.match(workflow, /CONTROL_ORIGIN=MISSING/);
  assert.match(workflow, /CONTROL_ORIGIN=VALID/);
  assert.match(workflow, /CONTROL_ORIGIN=INVALID/);
  assert.match(workflow, /DISPATCH_QUEUE_PRODUCER_BINDING=MISSING/);
  assert.match(workflow, /DISPATCH_QUEUE_PRODUCER_BINDING=PRESENT/);
  assert.match(workflow, /DISPATCH_QUEUE_PRODUCER_BINDING=INVALID/);
  assert.match(workflow, /NOTIFICATION_ACTIVATION_BINDING_FAILURES=%s/);
  assert.match(workflow, /NOTIFICATION_ACTIVATION_BINDINGS_INCOMPLETE/);

  assert.match(
    workflow,
    /CONTROL_TELEGRAM_BOT_TOKEN"\)\]\[0\] \| \.type == "secret_text" or \.type == "secret_key"/,
  );
  assert.match(
    workflow,
    /CONTROL_TELEGRAM_CHAT_ID"\)\]\[0\] \| \.type == "secret_text" or \.type == "secret_key"/,
  );
  assert.doesNotMatch(workflow, /TELEGRAM_BOT_TOKEN=.*\$\{/);
  assert.doesNotMatch(workflow, /TELEGRAM_CHAT_ID=.*\$\{/);
  assert.doesNotMatch(workflow, /api\.telegram\.org/);
  assert.doesNotMatch(workflow, /sendMessage/);

  assert.match(workflow, /D1_NOTIFICATION_MIGRATIONS=NOT_PROVEN_GET_ONLY/);
  assert.match(workflow, /WORKER_SOURCE_SHA=NOT_PROVEN_BY_CLOUDFLARE_GET/);
  assert.match(workflow, /TELEGRAM_ACTIVATION_PREFLIGHT=READY_FOR_LIVE_SCOPE_REVIEW/);
  assert.match(workflow, /NEXT_GATE=D1_MIGRATION_EVIDENCE_AND_EXACT_LIVE_SCOPE_REVIEW/);
  assert.match(workflow, /TELEGRAM_PROVIDER_REQUEST=NO/);
  assert.match(workflow, /QUEUE_MUTATION=NO/);
  assert.match(workflow, /REMOTE_D1_MUTATION=NO/);
  assert.match(workflow, /WORKER_MUTATION=NO/);
  assert.match(workflow, /CLOUDFLARE_CONFIG_MUTATION=NO/);
  assert.match(workflow, /SECRET_MUTATION=NO/);
  assert.match(workflow, /CLOUDFLARE_MUTATION=NO/);
  assert.match(workflow, /LIVE_AUTHORIZATION=NOT_GRANTED/);

  assert.doesNotMatch(workflow, /wrangler\s+(?:deploy|versions|d1|queues?)/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /(?:^|\s)--request\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /\/d1\/database/);
  assert.doesNotMatch(workflow, /\/messages\/purge/);
  assert.doesNotMatch(workflow, /\/purge(?:\?|\s|\x22)/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_D1_READ_TOKEN/);
  assert.doesNotMatch(workflow, /CONTROL_ACCESS_CLIENT_(?:ID|SECRET)/);
});
