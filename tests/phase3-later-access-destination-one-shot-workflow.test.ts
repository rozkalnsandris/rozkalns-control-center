import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = ".github/workflows/phase3-later-access-destination-one-shot.yml";

async function source(): Promise<string> {
  return readFile(workflow, "utf8");
}

test("Later Access destination workflow is manual, main-only, attempt-one and least privilege", async () => {
  const text = await source();
  assert.match(text, /^name: Phase 3 Later Access destination one-shot$/m);
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
  for (const forbiddenInput of [
    "approved_sha",
    "expected_ci_run_id",
    "expected_inventory_run_id",
    "access_app_id",
    "access_app_aud",
    "destination",
  ]) assert.doesNotMatch(dispatch, new RegExp(`\\n\\s+${forbiddenInput}:`));
});

test("owner authorization is one masked envelope and production secrets are step-scoped", async () => {
  const text = await source();
  const bindStart = text.indexOf("- name: Bind and mask owner authorization envelope");
  const executeStart = text.indexOf("- name: Revalidate and add exactly one Access destination", bindStart);
  assert.ok(bindStart >= 0 && executeStart > bindStart);
  const bind = text.slice(bindStart, executeStart);

  assert.match(bind, /GITHUB_EVENT_PATH/);
  assert.match(bind, /\.inputs\.owner_authorization/);
  assert.match(bind, /printf '::add-mask::%s\\n' "\$owner_authorization"/);
  assert.match(bind, /authorization_pattern='\^AUTHORIZE_ACCESS_LATER_DESTINATION_ADD:/);
  assert.match(bind, /:b3ebc664-8b21-401b-b8bb-2e5baa019a45:a8cce1f50660ab0f82afccb5d427be1107fc8b238b70cb67b57f00593493d6cc:PUT1\$'/);
  assert.match(bind, /OWNER_AUTHORIZATION_INVALID/);
  assert.doesNotMatch(bind, /secrets\.|github\.token/);

  const mask = bind.indexOf("printf '::add-mask::%s\\n'");
  const exportAuthorization = bind.indexOf("printf 'OWNER_AUTHORIZATION=%s\\n'");
  assert.ok(mask >= 0 && exportAuthorization > mask);
  for (const name of [
    "APPROVED_SHA",
    "EXPECTED_CI_RUN_ID",
    "EXPECTED_INVENTORY_RUN_ID",
    "OWNER_AUTHORIZATION",
  ]) assert.ok(bind.includes(`printf '${name}=%s\\n'`), `missing bound ${name}`);

  assert.doesNotMatch(text, /OWNER_AUTHORIZATION:\s*\$\{\{ inputs\.owner_authorization \}\}/);
  const execution = text.slice(executeStart);
  assert.match(execution, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(execution, /CLOUDFLARE_ACCESS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_ACCESS_READ_TOKEN \}\}/);
  assert.match(execution, /CLOUDFLARE_ACCESS_WRITE_TOKEN: \$\{\{ secrets\.CLOUDFLARE_ACCESS_WRITE_TOKEN \}\}/);
});

test("workflow binds exact main CI, exact inventory run and exact current Access trust boundary", async () => {
  const text = await source();
  for (const expected of [
    "70e29dbca0e8363358659102d2b74178",
    "b3ebc664-8b21-401b-b8bb-2e5baa019a45",
    "Rozkalns Control GitHub needs-changes write",
    "self_hosted",
    "control.rozkalns.net/api/github/needs-changes",
    "control.rozkalns.net/api/github/merge",
    "control.rozkalns.net/api/github/later",
    "a8cce1f50660ab0f82afccb5d427be1107fc8b238b70cb67b57f00593493d6cc",
    "4900e7a4-0f1a-4bbe-8eab-2607bf69a0f3",
    "rozkalns-control-github-readonly-reconcile",
    "non_identity",
    ".github/workflows/ci.yml",
    ".github/workflows/phase3-later-access-readonly-inventory.yml",
    "Phase 3 Later Access read-only inventory",
    "ACCESS_APP_PRESTATE_DRIFT",
    "ACCESS_POLICY_PRESTATE_DRIFT",
  ]) assert.ok(text.includes(expected), `missing ${expected}`);

  assert.match(text, /\.event == "push"/);
  assert.match(text, /\.event == "workflow_dispatch" or \.event == "issue_comment"/);
  assert.match(text, /\.run_attempt == 1/);
  assert.match(text, /revalidate_bound_state initial/);
  assert.match(text, /revalidate_bound_state prewrite/);
  assert.match(text, /validate_access_prestate initial/);
  assert.match(text, /validate_access_prestate prewrite/);
  assert.match(text, /ACCESS_APP_CHANGED_DURING_PREFLIGHT/);
  assert.match(text, /ACCESS_POLICY_CHANGED_DURING_PREFLIGHT/);
  assert.match(text, /\.result\.destinations \| length == 2/);
  assert.match(text, /index\(\$later\)\) == null/);
  assert.match(text, /\.result \| length == 1/);
  assert.match(text, /PREWRITE_GATE=PASS/);
});

test("exactly one Access application PUT consumes authorization and cannot retry or mutate adjacent systems", async () => {
  const text = await source();
  const puts = text.match(/\s-X PUT \\/g) ?? [];
  assert.equal(puts.length, 1);
  assert.doesNotMatch(text, /\s-X (?:POST|PATCH|DELETE) \\/);
  assert.doesNotMatch(text, /--retry|retry-all-errors|wrangler|migrations apply|d1\/database|CONTROL_ORIGIN/);
  assert.doesNotMatch(text, /\/policies[^\n]*-X PUT|-X PUT[^\n]*\/policies/);

  assert.match(text, /keys == \["destinations","domain","type"\]/);
  assert.match(text, /destinations:\[\{type:"public",uri:\$d1\},\{type:"public",uri:\$d2\},\{type:"public",uri:\$d3\}\]/);
  assert.match(text, /--data-binary "@\$tmp\/update-body\.json"/);

  const gate = text.indexOf("printf 'PREWRITE_GATE=PASS\\n'");
  const started = text.indexOf("printf 'ACCESS_PUT_STARTED=YES\\n'", gate);
  const consumed = text.indexOf("printf 'AUTHORIZATION_CONSUMED=YES\\n'", started);
  const put = text.indexOf("-X PUT", consumed);
  assert.ok(gate >= 0 && started > gate && consumed > started && put > consumed);

  assert.match(text, /NO_RETRY_ROLLBACK_CLEANUP=YES/);
  assert.match(text, /ACCESS_PUT_TRANSPORT_FAILED/);
  assert.match(text, /ACCESS_PUT_HTTP_NOT_200/);
  assert.match(text, /ACCESS_PUT_HTTP_STATUS=%s/);
  assert.match(text, /ACCESS_PUT_HTTP_STATUS=UNKNOWN/);
  assert.doesNotMatch(text, /cat\s+"?\$tmp\/update-response\.json/);
  assert.doesNotMatch(text, /printf[^\n]*update-response\.json/);
});

test("postwrite verification proves only the destination set changed and policies stayed identical", async () => {
  const text = await source();
  assert.match(text, /STAGE=POSTWRITE_READ_ONLY_VERIFICATION/);
  assert.match(text, /\.result\.destinations \| length == 3/);
  assert.match(text, /\(\[\.result\.destinations\[\]\.uri\] \| sort\) == \(\[\$d1,\$d2,\$d3\] \| sort\)/);
  assert.match(text, /POSTVERIFY_ACCESS_APP_DRIFT/);
  assert.match(text, /POSTVERIFY_ACCESS_POLICY_DRIFT/);
  assert.match(text, /POSTVERIFY_NONDESTINATION_APP_STATE_DRIFT/);
  assert.match(text, /POSTVERIFY_POLICY_STATE_DRIFT/);
  assert.match(text, /CLOUDFLARE_ACCESS_MUTATION=ONE_DESTINATION_ADD/);
  assert.match(text, /ACCESS_POLICY_MUTATION=NO/);
  assert.match(text, /NEW_DESTINATION_PRESENT=YES/);
  assert.match(text, /WORKER_MUTATION=NO/);
  assert.match(text, /REMOTE_D1_MUTATION=NO/);
  assert.match(text, /LATER_POST_SENT=NO/);
  assert.match(text, /GITHUB_DECISION_MUTATION=NO/);
  assert.match(text, /NEXT_GATE=FRESH_READ_ONLY_LATER_PREFLIGHT/);
});
