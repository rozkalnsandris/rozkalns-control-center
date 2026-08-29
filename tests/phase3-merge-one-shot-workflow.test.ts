import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = ".github/workflows/phase3-merge-one-shot-canary.yml";

async function source(): Promise<string> {
  return readFile(workflow, "utf8");
}

test("Merge canary workflow is manual, main-only, attempt-one and least privilege", async () => {
  const text = await source();
  assert.match(text, /^name: Phase 3 Merge one-shot canary$/m);
  assert.match(text, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(text, /\n\s+(?:push|pull_request|issue_comment|schedule):/);
  assert.match(text, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.match(
    text,
    /environment:\s*\n\s+name: production-readonly-reconcile\s*\n\s+deployment: false/,
  );
  assert.match(text, /GITHUB_REF_NAME:-}" = "main"/);
  assert.match(text, /GITHUB_RUN_ATTEMPT:-}" = "1"/);
  assert.match(text, /GITHUB_SHA:-}" = "\$\{APPROVED_SHA:-\}"/);
  assert.match(text, /cancel-in-progress: false/);
  assert.doesNotMatch(text, /contents:\s*write|actions:\s*write|pull-requests:\s*write/);
});

test("Merge canary binds exact source, CI, preflight, Worker and target tuple", async () => {
  const text = await source();
  for (const expected of [
    "rozkalnsandris/rozkalns-control-center",
    "rozkalnsandris/ops-workflows",
    "rozkalns-control-production",
    "8504e986-faf0-450c-bfb5-41b5dbf8be09",
    ".github/workflows/ci.yml",
    ".github/workflows/phase3-merge-readonly-preflight.yml",
    "EXACT_MAIN_CI_NOT_BOUND",
    "READONLY_PREFLIGHT_NOT_BOUND",
    "PRODUCTION_WORKER_BASELINE_DRIFT",
    "TARGET_ISSUE_DRIFT",
    "TARGET_PR_DRIFT",
    "TARGET_MAIN_DRIFT",
    "TARGET_CHECKS_NOT_READY",
    "TARGET_REVIEWS_NOT_READY",
    "TARGET_REVIEW_THREADS_NOT_CLEAN",
    "MERGE_TARGET_AUDIT_PRESTATE_NOT_EMPTY",
    "GENERATED_REQUEST_ID_ALREADY_PRESENT",
  ]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }

  assert.match(
    text,
    /AUTHORIZE_MERGE_CANARY:\$\{APPROVED_SHA\}:\$\{EXPECTED_CI_RUN_ID\}:\$\{EXPECTED_PREFLIGHT_RUN_ID\}:\$\{EXPECTED_DEPLOYMENT\}:\$\{EXPECTED_VERSION\}:\$\{ISSUE_NUMBER\}:\$\{PR_NUMBER\}:\$\{EXPECTED_PR_HEAD\}:\$\{EXPECTED_TARGET_MAIN\}:\$\{MERGE_METHOD\}:POST1/,
  );
  assert.match(text, /OWNER_AUTHORIZATION_INVALID/);
  assert.match(text, /MERGE_METHOD:-}" = "squash"/);
  assert.match(text, /FORBIDDEN_PR_3/);
  assert.match(text, /FORBIDDEN_ISSUE_4/);
  assert.match(text, /revalidate_bound_state initial/);
  assert.match(text, /revalidate_bound_state prewrite/);
  assert.match(text, /PREWRITE_GATE=PASS/);
});

test("prewrite authority is read-only and uses only existing service-token bindings", async () => {
  const text = await source();
  assert.match(
    text,
    /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  );
  assert.match(
    text,
    /CLOUDFLARE_D1_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_READ_TOKEN \}\}/,
  );
  assert.match(
    text,
    /CONTROL_ACCESS_CLIENT_ID: \$\{\{ secrets\.CONTROL_ACCESS_CLIENT_ID \}\}/,
  );
  assert.match(
    text,
    /CONTROL_ACCESS_CLIENT_SECRET: \$\{\{ secrets\.CONTROL_ACCESS_CLIENT_SECRET \}\}/,
  );
  assert.match(text, /meta\.changed_db/);
  assert.match(text, /meta\.rows_written/);
  assert.match(text, /meta\.changes/);
  assert.match(text, /SELECT request_id, state, mutation_attempted, merge_sha FROM merge_decisions/);
  assert.match(text, /SELECT request_id, state FROM merge_decisions WHERE request_id = \?/);
  assert.doesNotMatch(text, /GITHUB_APP_PRIVATE_KEY|GITHUB_WEBHOOK_SECRET/);
  assert.doesNotMatch(text, /production-worker-deploy|rozkalns-control-setup/);
  assert.doesNotMatch(text, /wrangler|migrations apply|d1 migrations|--retry/);
  assert.doesNotMatch(text, /-X (?:PUT|PATCH|DELETE)/);
});

test("exactly one Merge route call consumes authorization before the external POST", async () => {
  const text = await source();
  const mergeRoutes = text.match(/\$\{CONTROL_ORIGIN\}\/api\/github\/merge/g) ?? [];
  assert.equal(mergeRoutes.length, 1);

  const functionStart = text.indexOf("access_post_merge() {");
  const functionEnd = text.indexOf("wait_for_target_merge_convergence() {", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const accessPostMerge = text.slice(functionStart, functionEnd);

  const started = accessPostMerge.indexOf("printf 'MERGE_POST_STARTED=YES\\n'");
  const consumed = accessPostMerge.indexOf("printf 'AUTHORIZATION_CONSUMED=YES\\n'");
  const route = accessPostMerge.indexOf('"${CONTROL_ORIGIN}/api/github/merge"');
  assert.ok(started >= 0 && consumed > started && route > consumed);
  assert.match(accessPostMerge, /CF-Access-Client-Id/);
  assert.match(accessPostMerge, /CF-Access-Client-Secret/);
  assert.match(accessPostMerge, /MERGE_POST_SENT=UNKNOWN/);
  assert.match(accessPostMerge, /MERGE_POST_SENT=YES/);

  assert.match(text, /NO_RETRY_ROLLBACK_CLEANUP=YES/);
  assert.doesNotMatch(text, /--retry|retry-delay/);
  assert.doesNotMatch(text, /\/pulls\/\$\{PR_NUMBER\}\/merge/);
  assert.doesNotMatch(text, /merge_pull_request|gh\s+pr\s+merge|gh\s+api/);
});

test("post-write target convergence is bounded GET-only polling after MERGED response validation", async () => {
  const text = await source();
  const functionStart = text.indexOf("wait_for_target_merge_convergence() {");
  const functionEnd = text.indexOf("revalidate_bound_state() {", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const convergence = text.slice(functionStart, functionEnd);

  assert.match(convergence, /for attempt in 1 2 3 4 5; do/);
  assert.match(convergence, /gh_target_get_post "\/pulls\/\$\{PR_NUMBER\}"/);
  assert.match(convergence, /gh_target_get_post '\/branches\/main'/);
  assert.match(convergence, /POSTVERIFY_TARGET_PR_UNEXPECTED_DRIFT/);
  assert.match(convergence, /POSTVERIFY_TARGET_MAIN_UNEXPECTED_DRIFT/);
  assert.match(convergence, /POSTVERIFY_TARGET_MERGE_NOT_CONVERGED/);
  assert.match(convergence, /POSTVERIFY_TARGET_MERGE_CONVERGED_ATTEMPT/);
  assert.match(convergence, /sleep 2/);
  assert.doesNotMatch(convergence, /curl|-X POST|--data|api\/github\/merge/);
  assert.doesNotMatch(convergence, /while\s+/);

  const sleeps = text.match(/\bsleep\s+\d+\b/g) ?? [];
  assert.deepEqual(sleeps, ["sleep 2"]);

  const mergedResponseValidation = text.indexOf('.status == "MERGED"');
  const convergenceCall = text.indexOf('wait_for_target_merge_convergence "$merge_sha"');
  assert.ok(mergedResponseValidation >= 0 && convergenceCall > mergedResponseValidation);
});

test("success path proves exact Merge result and one terminal D1 audit row", async () => {
  const text = await source();
  for (const expected of [
    '.status == "MERGED"',
    '.state == "closed"',
    ".merged == true",
    ".merge_commit_sha == $merge",
    ".commit.sha == $sha",
    '$row.state == "SUCCEEDED"',
    "$row.outcome_code == null",
    "$row.mutation_attempted == 1",
    "$row.observed_head_sha == $head",
    "$row.observed_main_sha == $main",
    "$row.merge_sha == $merge",
    "POSTVERIFY_MERGE_AUDIT_ROW_INVALID",
    "POSTVERIFY_CONTROL_MAIN_DRIFT",
    "POSTVERIFY_PRODUCTION_WORKER_DRIFT",
    "MERGE_CANARY=PASS",
  ]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }

  assert.match(
    text,
    /REMOTE_D1_MUTATION=ONE_MERGE_AUDIT_LIFECYCLE_THROUGH_WORKER/,
  );
  assert.match(
    text,
    /GITHUB_DECISION_MUTATION=ONE_EXACT_PR_MERGE_THROUGH_WORKER/,
  );
  assert.match(text, /WORKER_MUTATION=NO/);
  assert.match(text, /CLOUDFLARE_CONFIG_MUTATION=NO/);
  assert.match(text, /GITHUB_APP_PERMISSION_MUTATION=NO/);

  assert.doesNotMatch(text, /\/workers\/scripts\/[^\n]*\/versions/);
  assert.doesNotMatch(text, /\/environments\//);
});
