import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPath = ".github/workflows/phase3-merge-readonly-preflight.yml";
const source = readFileSync(workflowPath, "utf8");

test("Merge D1 preflight supports only manual or exact owner-comment execution with read-only authority", () => {
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /issue_comment:\s*\n\s+types: \[created\]/);
  assert.match(source, /github\.event\.issue\.number == 278/);
  assert.match(source, /github\.event\.issue\.pull_request == null/);
  assert.match(source, /github\.event\.comment\.user\.id == 277435981/);
  assert.match(source, /github\.event\.comment\.user\.type == 'User'/);
  assert.match(source, /github\.event\.comment\.body == '\/phase3-merge-preflight'/);
  assert.match(source, /\.issue\.number == 278/);
  assert.match(source, /has\("pull_request"\) \| not/);
  assert.match(source, /\.comment\.user\.id == 277435981/);
  assert.match(source, /\.comment\.user\.type == "User"/);
  assert.match(source, /\.comment\.body == "\/phase3-merge-preflight"/);
  assert.match(source, /OWNER_COMMENT_TRIGGER_INVALID/);
  assert.match(source, /WORKFLOW_EVENT_UNSUPPORTED/);

  assert.match(source, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.doesNotMatch(source, /actions: write|issues: write|pull-requests: write|contents: write/);
  assert.match(source, /name: production-readonly-reconcile/);
  assert.match(source, /deployment: false/);

  assert.match(source, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(source, /secrets\.CLOUDFLARE_D1_READ_TOKEN/);
  assert.doesNotMatch(source, /CONTROL_ACCESS_CLIENT_ID|CONTROL_ACCESS_CLIENT_SECRET/);
  assert.doesNotMatch(source, /GITHUB_APP_PRIVATE_KEY|WEBHOOK_SECRET/);
});

test("Merge D1 preflight proves exact main CI and one active 100% Worker version without deployment mutation", () => {
  assert.match(source, /GITHUB_REF_NAME:-.*main/);
  assert.match(source, /\.commit\.sha == \$sha/);
  assert.match(source, /event=push&branch=main&head_sha=\$\{run_sha\}/);
  assert.match(source, /conclusion == "success"/);
  assert.match(source, /cf_workers_get "\/workers\/scripts\/\$\{WORKER_NAME\}\/deployments"/);
  assert.match(source, /\.result\.deployments\[0\]\.versions \| length == 1/);
  assert.match(source, /\.percentage == 100/);
  assert.match(source, /PRODUCTION_WORKER_FINAL_DRIFT/);

  assert.doesNotMatch(source, /wrangler\s+(deploy|versions\s+upload|versions\s+deploy|d1\s+migrations\s+apply)/i);
  assert.doesNotMatch(source, /curl[^\n]*-X\s+(PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(source, /gh\s+(pr\s+merge|run\s+rerun|run\s+cancel)/i);
});

test("Merge D1 preflight pins migration 0008 schema, indexes and a zero-row pre-canary state", () => {
  assert.match(source, /\/d1\/database\/\$\{DB_ID\}/);
  assert.match(source, /\.result\.uuid == \$id and \.result\.name == \$name/);

  assert.equal((source.match(/-X POST/g) ?? []).length, 1);
  assert.match(source, /PRAGMA table_info\("merge_decisions"\)/);
  assert.match(source, /PRAGMA index_list\("merge_decisions"\)/);
  assert.match(source, /PRAGMA index_info\("idx_merge_decisions_state_requested_at"\)/);
  assert.match(source, /PRAGMA index_info\("idx_merge_decisions_repository_pull_requested_at"\)/);
  assert.match(source, /SELECT COUNT\(\*\) AS row_count FROM merge_decisions/);

  const expectedColumns = [
    "request_id",
    "fingerprint",
    "actor_subject",
    "actor_email",
    "repository",
    "project_id",
    "issue_number",
    "pull_number",
    "merge_method",
    "expected_head_sha",
    "expected_main_sha",
    "requested_at",
    "state",
    "outcome_code",
    "mutation_attempted",
    "observed_head_sha",
    "observed_main_sha",
    "observed_at",
    "merge_sha",
    "completed_at",
  ];
  for (const column of expectedColumns) {
    assert.match(source, new RegExp(`name:"${column}"`));
  }

  assert.match(source, /\["state", "requested_at"\]/);
  assert.match(source, /\["repository", "pull_number", "requested_at"\]/);
  assert.match(source, /MERGE_DECISIONS_SCHEMA=PASS/);
  assert.match(source, /MERGE_DECISIONS_INDEXES=PASS/);
  assert.match(source, /MERGE_DECISIONS_ROW_COUNT=0/);
  assert.match(source, /MERGE_DECISIONS_NOT_EMPTY/);

  assert.match(source, /meta\.changed_db/);
  assert.match(source, /meta\.rows_written/);
  assert.match(source, /meta\.changes/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i);
});

test("Merge D1 preflight has no Merge, permission, Cloudflare config or decision mutation path", () => {
  assert.doesNotMatch(source, /\/api\/github\/merge/i);
  assert.doesNotMatch(source, /contents:\s*write/i);
  assert.doesNotMatch(source, /permissions?\/|installation.*permissions?|repositories\/.*installation/i);

  assert.match(source, /MERGE_POST_SENT=NO/);
  assert.match(source, /REMOTE_D1_MUTATION=NO/);
  assert.match(source, /WORKER_MUTATION=NO/);
  assert.match(source, /CLOUDFLARE_CONFIG_MUTATION=NO/);
  assert.match(source, /GITHUB_DECISION_MUTATION=NO/);
  assert.match(source, /GITHUB_APP_PERMISSION_MUTATION=NO/);
});
