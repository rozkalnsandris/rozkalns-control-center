import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-d1-live.yml";
const EXECUTOR_PATH = "scripts/phase5-rpi5-observation-d1-live.mjs";
const PREFLIGHT_PATH = ".github/workflows/phase5-rpi5-observation-readonly-preflight.yml";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const workflow = source(WORKFLOW_PATH);
const executor = source(EXECUTOR_PATH);
const preflight = source(PREFLIGHT_PATH);

const migrations = [
  "0001_reconciliation_core.sql",
  "0002_needs_changes_audit.sql",
  "0003_notification_transitions.sql",
  "0004_notification_delivery_intents.sql",
  "0005_notification_delivery_attempts.sql",
  "0006_notification_delivery_dispatch_claims.sql",
  "0007_continuation_campaigns.sql",
  "0008_merge_decision_audit.sql",
  "0009_later_deferrals.sql",
  "0010_webhook_observability_hot_index.sql",
  "0011_rpi5_observation_replay_claims.sql",
  "0012_rpi5_production_visibility_projection.sql",
  "0013_rpi5_observation_atomic_acceptance.sql",
];

test("Phase 5 D1 executor is manual-only with read-only GitHub permissions", () => {
  assert.ok(workflow.includes("on:\n  workflow_dispatch:"));
  assert.ok(!workflow.includes("\n  push:"));
  assert.ok(!workflow.includes("\n  pull_request:"));
  assert.ok(workflow.includes("permissions:\n  contents: read\n  actions: read"));
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /ref: \$\{\{ inputs\.approved_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
});

test("workflow keeps read and write Cloudflare credentials separated", () => {
  assert.match(workflow, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_D1_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_READ_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_D1_WRITE_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_WRITE_TOKEN \}\}/);
  assert.match(workflow, /node scripts\/phase5-rpi5-observation-d1-live\.mjs/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_D1_WRITE_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
});

test("executor freezes the complete source migration set and exact pending prefix", () => {
  for (const migration of migrations) assert.match(executor, new RegExp(migration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(executor, /SOURCE_MIGRATION_SET_INVALID/);
  assert.match(executor, /PREWRITE_MIGRATION_HISTORY_INVALID/);
  assert.match(executor, /POST_MIGRATION_HISTORY_INVALID/);
  assert.match(executor, /SELECT id, name FROM d1_migrations ORDER BY id/);
  assert.match(executor, /PHASE5_MIGRATIONS\.join\(","\)/);
  assert.match(executor, /PHASE5_MIGRATIONS\.slice\(1\)\.join\(","\)/);
});

test("executor binds current main, exact CI, exact preflight and Worker baseline", () => {
  for (const required of [
    "GITHUB_RUN_ATTEMPT",
    "workflow_dispatch",
    "refs/heads/main",
    ".github/workflows/ci.yml",
    ".github/workflows/phase5-rpi5-observation-readonly-preflight.yml",
    "MAIN_SHA_DRIFT",
    "CI_GATE_INVALID",
    "PREFLIGHT_GATE_INVALID",
    "WORKER_BASELINE_DRIFT",
    "CONTROL_DB_BINDING_DRIFT",
    "INGEST_BASELINE_DRIFT",
    "VERIFICATION_KEY_BASELINE_DRIFT",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(executor, /source_sha=\$\{a\.sha\} ci_run=\$\{a\.ciRun\} preflight_run=\$\{a\.preflightRun\} deployment=\$\{a\.deployment\} version=\$\{a\.version\}/);
});

test("executor consumes authorization immediately before exactly one Wrangler apply", () => {
  const marker = executor.indexOf('console.log("APPLY_STARTED=YES")');
  const apply = executor.indexOf("const result = spawnSync(wrangler()");
  assert.ok(marker >= 0 && apply > marker);
  assert.equal((executor.match(/spawnSync\(wrangler\(\)/g) ?? []).length, 1);
  assert.equal((executor.match(/"d1", "migrations", "apply"/g) ?? []).length, 1);
  assert.match(executor, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(executor, /POST_APPLY_STATE=REVIEW_REQUIRED/);
  assert.match(executor, /NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES/);
  assert.doesNotMatch(executor, /while\s*\(/);
});

test("postwrite probes and standard readonly preflight use real replay columns", () => {
  assert.match(executor, /replay_expires_at_ms, claimed_at_ms, claim_token/);
  assert.match(preflight, /replay_expires_at_ms, claimed_at_ms, claim_token/);
  assert.doesNotMatch(preflight, /SELECT replay_key, replay_expires_at, claim_token/);
  assert.match(executor, /POST_PHASE5_ROWS_NOT_EMPTY/);
  assert.match(executor, /REMOTE_D1_MIGRATION_GATE=PASS/);
});
