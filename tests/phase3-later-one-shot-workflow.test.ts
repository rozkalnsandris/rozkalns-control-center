import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = ".github/workflows/phase3-later-one-shot-canary.yml";

async function source(): Promise<string> {
  return readFile(workflow, "utf8");
}

test("Later canary workflow is manual, main-only, attempt-one and least privilege", async () => {
  const text = await source();
  assert.match(text, /^name: Phase 3 Later one-shot canary$/m);
  assert.match(text, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(text, /\n\s+(?:push|pull_request|issue_comment|schedule):/);
  assert.match(text, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.match(text, /environment:\s*\n\s+name: production-readonly-reconcile\s*\n\s+deployment: false/);
  assert.match(text, /GITHUB_REF_NAME:-}" = "main"/);
  assert.match(text, /GITHUB_RUN_ATTEMPT:-}" = "1"/);
  assert.match(text, /GITHUB_SHA:-}" = "\$\{APPROVED_SHA:-\}"/);
  assert.match(text, /cancel-in-progress: false/);

  const dispatchStart = text.indexOf("  workflow_dispatch:");
  const permissionsStart = text.indexOf("\npermissions:", dispatchStart);
  assert.ok(dispatchStart >= 0 && permissionsStart > dispatchStart);
  const dispatch = text.slice(dispatchStart, permissionsStart);
  assert.match(dispatch, /\n\s+owner_authorization:\s*\n/);
  for (const removedInput of [
    "approved_sha",
    "expected_ci_run_id",
    "expected_preflight_run_id",
    "expected_deployment",
    "expected_version",
    "pr_number",
    "expected_pr_head",
    "expected_target_main",
    "expected_fingerprint",
  ]) assert.doesNotMatch(dispatch, new RegExp(`\\n\\s+${removedInput}:`));
});

test("Later canary derives the exact tuple from one masked owner envelope", async () => {
  const text = await source();
  const bindStart = text.indexOf("- name: Bind and mask owner authorization envelope");
  const executeStart = text.indexOf("- name: Revalidate and execute one authorized Later POST", bindStart);
  assert.ok(bindStart >= 0 && executeStart > bindStart);
  const bind = text.slice(bindStart, executeStart);

  assert.match(bind, /GITHUB_EVENT_PATH/);
  assert.match(bind, /\.inputs\.owner_authorization/);
  assert.match(bind, /printf '::add-mask::%s\\n' "\$owner_authorization"/);
  assert.match(bind, /authorization_pattern='\^AUTHORIZE_LATER_CANARY:/);
  assert.match(bind, /:POST1\$'/);
  assert.match(bind, /OWNER_AUTHORIZATION_INVALID/);

  const mask = bind.indexOf("printf '::add-mask::%s\\n'");
  const exportAuthorization = bind.indexOf("printf 'OWNER_AUTHORIZATION=%s\\n'");
  assert.ok(mask >= 0 && exportAuthorization > mask);

  for (const name of [
    "APPROVED_SHA",
    "EXPECTED_CI_RUN_ID",
    "EXPECTED_PREFLIGHT_RUN_ID",
    "EXPECTED_DEPLOYMENT",
    "EXPECTED_VERSION",
    "PR_NUMBER",
    "EXPECTED_PR_HEAD",
    "EXPECTED_TARGET_MAIN",
    "EXPECTED_FINGERPRINT",
    "OWNER_AUTHORIZATION",
  ]) assert.ok(bind.includes(`printf '${name}=%s\\n'`), `missing bound ${name}`);

  assert.doesNotMatch(text, /\$\{\{ inputs\.(?:approved_sha|expected_ci_run_id|expected_preflight_run_id|expected_deployment|expected_version|pr_number|expected_pr_head|expected_target_main|expected_fingerprint) \}\}/);
  assert.doesNotMatch(text, /OWNER_AUTHORIZATION:\s*\$\{\{ inputs\.owner_authorization \}\}/);
  assert.doesNotMatch(bind, /secrets\.|github\.token/);

  const execution = text.slice(executeStart);
  assert.match(execution, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(execution, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(execution, /CLOUDFLARE_D1_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_READ_TOKEN \}\}/);
});

test("Later canary binds exact source, CI, supported read-only preflight event and target evidence", async () => {
  const text = await source();
  for (const expected of [
    "rozkalnsandris/rozkalns-control-center",
    "rozkalnsandris/ops-workflows",
    "rozkalns-control-production",
    "8504e986-faf0-450c-bfb5-41b5dbf8be09",
    ".github/workflows/ci.yml",
    ".github/workflows/phase3-later-readonly-preflight.yml",
    "READONLY_PREFLIGHT_NOT_BOUND",
    "PRODUCTION_WORKER_BASELINE_DRIFT",
    "DASHBOARD_TARGET_REVALIDATION_FAILED",
    "TARGET_PR_DRIFT",
    "TARGET_MAIN_DRIFT",
    "LATER_DEFERRAL_PRESTATE_NOT_EMPTY",
  ]) assert.ok(text.includes(expected), `missing ${expected}`);

  const preflightRunStart = text.indexOf(
    'gh_control_get_pre "/actions/runs/${EXPECTED_PREFLIGHT_RUN_ID}"',
  );
  const preflightRunEnd = text.indexOf(
    'cf_workers_get "/workers/scripts/${WORKER_NAME}/deployments"',
    preflightRunStart,
  );
  assert.ok(preflightRunStart >= 0 && preflightRunEnd > preflightRunStart);
  const preflightRunCheck = text.slice(preflightRunStart, preflightRunEnd);

  assert.match(
    preflightRunCheck,
    /\.event == "workflow_dispatch" or \.event == "issue_comment"/,
  );
  assert.doesNotMatch(preflightRunCheck, /\.event == "(?:push|pull_request|schedule)"/);
  assert.match(preflightRunCheck, /\.run_attempt == 1/);
  assert.match(
    text,
    /AUTHORIZE_LATER_CANARY:\$\{APPROVED_SHA\}:\$\{EXPECTED_CI_RUN_ID\}:\$\{EXPECTED_PREFLIGHT_RUN_ID\}:\$\{EXPECTED_DEPLOYMENT\}:\$\{EXPECTED_VERSION\}:\$\{PR_NUMBER\}:\$\{EXPECTED_PR_HEAD\}:\$\{EXPECTED_TARGET_MAIN\}:\$\{EXPECTED_FINGERPRINT\}:POST1/,
  );
  assert.match(text, /OWNER_AUTHORIZATION_INVALID/);
  assert.match(text, /revalidate_bound_state initial/);
  assert.match(text, /revalidate_bound_state prewrite/);
  assert.match(text, /PREWRITE_GATE=PASS/);
});

test("prewrite Cloudflare access is read-only and D1 queries prove zero writes", async () => {
  const text = await source();
  assert.match(text, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(text, /CLOUDFLARE_D1_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_READ_TOKEN \}\}/);
  assert.match(text, /meta\.changed_db/);
  assert.match(text, /meta\.rows_written/);
  assert.match(text, /meta\.changes/);
  assert.match(text, /SELECT decision_id, schema_version, project_id, issue_number, pr_number, state_fingerprint, deferred_at FROM later_deferrals/);
  assert.doesNotMatch(text, /production-worker-deploy|rozkalns-control-setup/);
  assert.doesNotMatch(text, /wrangler|migrations apply|d1 migrations|--retry/);
  assert.doesNotMatch(text, /-X (?:PUT|PATCH|DELETE)/);
});

test("exactly one Later route call consumes authorization before the external POST", async () => {
  const text = await source();
  const laterRoutes = text.match(/\$\{CONTROL_ORIGIN\}\/api\/github\/later/g) ?? [];
  assert.equal(laterRoutes.length, 1);

  const functionStart = text.indexOf("access_post_later() {");
  const functionEnd = text.indexOf('cat > "$tmp/evaluate-dashboard.mjs"', functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const accessPostLater = text.slice(functionStart, functionEnd);

  const started = accessPostLater.indexOf("printf 'LATER_POST_STARTED=YES\\n'");
  const consumed = accessPostLater.indexOf("printf 'AUTHORIZATION_CONSUMED=YES\\n'");
  const route = accessPostLater.indexOf('"${CONTROL_ORIGIN}/api/github/later"');
  assert.ok(started >= 0 && consumed > started && route > consumed);

  const postCount = text.match(/\s-X POST \\/g) ?? [];
  assert.equal(postCount.length, 3, "two D1 SELECT API calls plus one Later POST are expected");
  assert.match(text, /NO_RETRY_ROLLBACK_CLEANUP=YES/);
});

test("non-200 Later POST preserves only bounded status and stable route error evidence", async () => {
  const text = await source();
  assert.match(text, /emit_later_post_failure_evidence\(\)/);
  assert.match(text, /LATER_POST_HTTP_STATUS=%s/);
  assert.match(text, /LATER_POST_HTTP_STATUS=UNKNOWN/);
  assert.match(text, /LATER_POST_ERROR_CODE=%s/);
  for (const code of [
    "ACCESS_AUTHENTICATION_FAILED",
    "AUTHORIZATION_STALE_STATE",
    "RECONCILIATION_FAILED",
    "PERSISTENCE_FAILED",
    "PERSISTENCE_CONFLICT",
    "RUNTIME_UNAVAILABLE",
  ]) assert.ok(text.includes(code), `missing bounded Later error ${code}`);

  const statusCheck = text.indexOf('if [ "$(cat "$tmp/later-response.code")" != "200" ]; then');
  const evidence = text.indexOf(
    'emit_later_post_failure_evidence "$tmp/later-response.code" "$tmp/later-response.json"',
    statusCheck,
  );
  const stopped = text.indexOf("stop_post LATER_POST_HTTP_NOT_200", evidence);
  assert.ok(statusCheck >= 0 && evidence > statusCheck && stopped > evidence);

  assert.doesNotMatch(text, /cat\s+"\$tmp\/later-response\.json"/);
  assert.doesNotMatch(text, /printf[^\n]*later-response\.json/);
  assert.match(text, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(text, /NO_RETRY_ROLLBACK_CLEANUP=YES/);
});

test("postwrite path requires DEFERRED and one exact persisted row without GitHub mutation", async () => {
  const text = await source();
  assert.match(text, /\.status == "DEFERRED"/);
  assert.match(text, /POSTVERIFY_DEFERRAL_ROWS=1/);
  assert.match(text, /\.result\[0\]\.results\[0\]\.deferred_at == \$observed/);
  assert.match(text, /POSTVERIFY_TARGET_PR_DRIFT/);
  assert.match(text, /POSTVERIFY_TARGET_MAIN_DRIFT/);
  assert.match(text, /POSTVERIFY_CONTROL_MAIN_DRIFT/);
  assert.match(text, /REMOTE_D1_MUTATION=ONE_LATER_DEFERRAL_WRITE_THROUGH_WORKER/);
  assert.match(text, /GITHUB_DECISION_MUTATION=NO/);
  assert.match(text, /WORKER_MUTATION=NO/);
  assert.match(text, /CLOUDFLARE_CONFIG_MUTATION=NO/);

  assert.doesNotMatch(text, /gh\s+(?:pr|api|secret|workflow)|add_review|REQUEST_CHANGES|merge_pull_request/);
  assert.doesNotMatch(text, /\/reviews(?:\?|"|'|\s)/);
  assert.doesNotMatch(text, /\/workers\/scripts\/[^\n]*\/versions/);
  assert.doesNotMatch(text, /\/environments\//);
});