import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = ".github/workflows/phase3-merge-postcanary-readonly-reconcile.yml";

async function source(): Promise<string> {
  return readFile(workflow, "utf8");
}

test("post-canary reconciler is owner-comment-triggered, main-only and least privilege", async () => {
  const text = await source();
  assert.match(text, /^name: Phase 3 Merge post-canary read-only reconciliation$/m);
  assert.match(text, /issue_comment:\s*\n\s+types: \[created\]/);
  assert.doesNotMatch(text, /\n\s+(?:push|pull_request|schedule|workflow_dispatch):/);
  assert.match(text, /github\.event\.issue\.number == 278/);
  assert.match(text, /github\.event\.comment\.user\.id == 277435981/);
  assert.match(text, /startsWith\(github\.event\.comment\.body, '\/phase3-merge-postcanary-reconcile:'\)/);
  assert.match(text, /GITHUB_REF_NAME:-}" = "main"/);
  assert.match(text, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.match(text, /name: production-readonly-reconcile\s*\n\s+deployment: false/);
});

test("trigger fields and canary evidence are tightly bound", async () => {
  const text = await source();
  for (const expected of [
    "CANARY_RUN_ID_INVALID",
    "REQUEST_ID_INVALID",
    "CANARY_SOURCE_SHA_INVALID",
    "FORBIDDEN_PR_3",
    "FORBIDDEN_ISSUE_4",
    "EXPECTED_PR_HEAD_INVALID",
    "EXPECTED_OLD_MAIN_INVALID",
    "EXPECTED_MERGE_SHA_INVALID",
    "Phase 3 Merge one-shot canary",
    ".github/workflows/phase3-merge-one-shot-canary.yml",
    "execute exact authorized one-shot Merge canary",
    "CANARY_RUN_NOT_BOUND_TERMINAL_FAILURE",
    "CANARY_JOB_NOT_BOUND_FAILURE",
    "TARGET_PR_NUMBER_MISMATCH",
    "TARGET_PR_NOT_CLOSED",
    "TARGET_PR_MERGED_AT_INVALID",
    "TARGET_PR_DRAFT_INVALID",
    "TARGET_PR_HEAD_MISMATCH",
    "TARGET_PR_HEAD_REPO_MISMATCH",
    "TARGET_PR_BASE_MISMATCH",
    "TARGET_PR_MERGE_SHA_MISMATCH",
    "TARGET_PR_MERGED_EVENT_MISMATCH",
    "TARGET_MERGE_PARENT_MISMATCH",
    "TARGET_MAIN_NO_LONGER_DESCENDS_FROM_MERGE",
  ]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
  assert.match(text, /TARGET_REPOSITORY: rozkalnsandris\/ops-workflows/);
  assert.match(text, /\.conclusion == "failure"/);
  assert.match(text, /\.state == "closed"/);
  assert.match(text, /\(\.merged_at \| type\) == "string"/);
  assert.match(text, /\(\.merged_at \| length\) > 0/);
  assert.doesNotMatch(text, /\.merged == true/);
  assert.match(text, /\.merge_commit_sha == \$merge/);
  assert.match(text, /\.parents\[0\]\.sha == \$old_main/);
  assert.match(text, /\.merge_base_commit\.sha == \$merge/);
});

test("target PR diagnostics preserve every merge-evidence predicate", async () => {
  const text = await source();
  for (const predicate of [
    '.number == $number',
    '.state == "closed"',
    '(.merged_at | type) == "string" and (.merged_at | length) > 0',
    '.draft == false',
    '.head.sha == $head',
    '.head.repo.full_name == $repo',
    '.base.ref == "main" and .base.repo.full_name == $repo',
    '.merge_commit_sha == $merge',
  ]) {
    assert.ok(text.includes(predicate), `missing predicate ${predicate}`);
  }
  assert.doesNotMatch(text, /TARGET_PR_MERGE_EVIDENCE_MISMATCH/);
});

test("merge SHA proof uses exact PR evidence or bounded merged-event fallback", async () => {
  const text = await source();
  const validObservedBranch = 'if [[ "$observed_merge_sha" =~ ^[0-9a-f]{40}$ ]]; then';
  const exactEquality = 'if ! jq -e --arg merge "$expected_merge_sha" \'.merge_commit_sha == $merge\' "$tmp/target-pr.json" >/dev/null; then';
  const mismatchStop = "stop TARGET_PR_MERGE_SHA_MISMATCH";
  const fallbackMarker = "TARGET_PR_MERGE_SHA_EVIDENCE=TIMELINE_FALLBACK";

  assert.ok(text.includes('observed_merge_sha="$(jq -r \'.merge_commit_sha // empty\' "$tmp/target-pr.json")"'));
  assert.ok(text.includes(validObservedBranch));
  assert.ok(text.includes(exactEquality));
  assert.ok(text.includes("printf 'TARGET_PR_MERGE_SHA_EXPECTED=%s\\n' \"$expected_merge_sha\""));
  assert.ok(text.includes("printf 'TARGET_PR_MERGE_SHA_OBSERVED=%s\\n' \"$observed_merge_sha\""));

  const validBranchIndex = text.indexOf(validObservedBranch);
  const mismatchStopIndex = text.indexOf(mismatchStop, validBranchIndex);
  const fallbackIndex = text.indexOf(fallbackMarker);
  assert.ok(validBranchIndex >= 0);
  assert.ok(mismatchStopIndex > validBranchIndex);
  assert.ok(fallbackIndex > mismatchStopIndex, "valid but different merge SHA must stop before timeline fallback");

  assert.ok(text.includes("printf 'TARGET_PR_MERGE_SHA_OBSERVED=INVALID_OR_MISSING\\n'"));
  assert.ok(text.includes("merged_at=\"$(jq -r '.merged_at' \"$tmp/target-pr.json\")\""));
  assert.ok(text.includes('gh_target_get "/issues/${pr_number}/timeline?per_page=100" "$tmp/target-pr-timeline.json"'));
  assert.ok(text.includes('([.[]? | select(.event == "merged")] | length) == 1'));
  assert.ok(text.includes('.commit_id == $merge'));
  assert.ok(text.includes('.created_at == $merged_at'));
  assert.ok(text.includes("stop TARGET_PR_MERGED_EVENT_MISMATCH"));
  assert.doesNotMatch(text, /cat\s+"?\$tmp\/target-pr(?:-timeline)?\.json/);
});

test("D1 evidence is SELECT-only and every query proves zero writes", async () => {
  const text = await source();
  assert.match(text, /CLOUDFLARE_D1_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_READ_TOKEN \}\}/);
  assert.match(text, /\[\[ "\$sql" == SELECT\\ \* \]\] \|\| stop D1_QUERY_NOT_SELECT/);
  assert.match(text, /meta\.changed_db/);
  assert.match(text, /meta\.rows_written/);
  assert.match(text, /meta\.changes/);
  assert.match(text, /FROM merge_decisions WHERE request_id = \? LIMIT 2/);
  assert.match(text, /FROM merge_decisions WHERE repository = \? AND pull_number = \?/);
  assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|PRAGMA)\b/i);
  assert.doesNotMatch(text, /migrations apply|d1 migrations|wrangler/);
});

test("reconciler has no Merge, deploy, Access or permission mutation path", async () => {
  const text = await source();
  assert.doesNotMatch(text, /CONTROL_ORIGIN|api\/github\/merge|CF-Access-Client-Id|CF-Access-Client-Secret/);
  assert.doesNotMatch(text, /merge_pull_request|gh\s+pr\s+merge|\/pulls\/\$\{[^}]+\}\/merge/);
  assert.doesNotMatch(text, /workers\/scripts\/[^\\n]*\/versions|deployments\/|permissions:\s*write/);
  assert.doesNotMatch(text, /-X (?:PUT|PATCH|DELETE)/);
  assert.match(text, /MERGE_POST_SENT=NO/);
  assert.match(text, /REMOTE_D1_MUTATION=NO/);
  assert.match(text, /WORKER_MUTATION=NO/);
  assert.match(text, /CLOUDFLARE_CONFIG_MUTATION=NO/);
  assert.match(text, /GITHUB_DECISION_MUTATION=NO/);
  assert.match(text, /GITHUB_APP_PERMISSION_MUTATION=NO/);
});

test("success path proves one terminal exact audit row", async () => {
  const text = await source();
  for (const expected of [
    '$row.state == "SUCCEEDED"',
    "$row.outcome_code == null",
    "$row.mutation_attempted == 1",
    "$row.observed_head_sha == $head",
    "$row.observed_main_sha == $old_main",
    "$row.merge_sha == $merge",
    "MERGE_AUDIT_ROW_INVALID",
    "MERGE_TARGET_AUDIT_NOT_EXACTLY_ONE",
    "MERGE_POSTCANARY_RECONCILE=PASS",
    "D1_AUDIT_STATE=SUCCEEDED",
    "D1_TARGET_ROW_COUNT=1",
  ]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
});
