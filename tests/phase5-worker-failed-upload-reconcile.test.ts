import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-worker-failed-upload-reconcile.yml";
const RECONCILER_PATH = "scripts/phase5-rpi5-observation-worker-failed-upload-reconcile.mjs";

const source = (path: string): string => readFileSync(path, "utf8");
const workflow = source(WORKFLOW_PATH);
const reconciler = source(RECONCILER_PATH);

test("failed-upload reconciliation workflow is manual and read-only credential scoped", () => {
  assert.ok(workflow.includes("on:\n  workflow_dispatch:"));
  assert.ok(!workflow.includes("\n  push:"));
  assert.ok(!workflow.includes("\n  pull_request:"));
  assert.ok(workflow.includes("permissions:\n  contents: read\n  actions: read"));
  assert.match(workflow, /environment: production-readonly-reconcile/);
  assert.match(workflow, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN|CLOUDFLARE_D1_READ_TOKEN/);
  assert.match(workflow, /persist-credentials: false/);
});

test("workflow binds current source, failed source, CI, failed activation and pre-attempt Worker baseline", () => {
  for (const required of [
    "approved_sha:",
    "expected_ci_run:",
    "failed_activation_run:",
    "failed_source_sha:",
    "expected_deployment:",
    "expected_version:",
    "expected_non_target_bindings_sha256:",
  ]) assert.match(workflow, new RegExp(required));
  assert.match(workflow, /FAILED_SOURCE_SHA: \$\{\{ inputs\.failed_source_sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ inputs\.approved_sha \}\}/);
  assert.match(workflow, /phase5-rpi5-observation-worker-failed-upload-reconcile\.mjs/);
});

test("reconciler permits post-fix current main only when failed source remains an ancestor with unchanged Worker config", () => {
  for (const required of [
    "/compare/${a.failedSourceSha}...${a.sha}",
    "FAILED_SOURCE_NOT_CURRENT_MAIN_ANCESTOR",
    "/contents/wrangler.jsonc?ref=${a.failedSourceSha}",
    "/contents/wrangler.jsonc?ref=${a.sha}",
    "WRANGLER_CONFIG_DRIFT_SINCE_FAILED_SOURCE",
    "failed?.head_sha !== a.failedSourceSha",
    "job?.head_sha === a.failedSourceSha",
  ]) assert.ok(reconciler.includes(required), `missing source-continuity invariant: ${required}`);
  assert.doesNotMatch(reconciler, /failed\?\.head_sha !== a\.sha/);
});

test("reconciler proves exact failed mutation step and uses its bounded time window", () => {
  for (const required of [
    ".github/workflows/phase5-rpi5-observation-worker-activate-live.yml",
    "Phase 5 RPi5 observation Worker activate",
    "one-shot exact-candidate Worker activation",
    "Execute one-shot Worker activation mutation class",
    "FAILED_ACTIVATION_RUN_INVALID",
    "FAILED_ACTIVATION_JOB_INVALID",
    "FAILED_MUTATION_STEP_INVALID",
    "failed?.run_attempt !== 1",
    "CLOCK_SKEW_MS = 30_000",
  ]) assert.ok(reconciler.includes(required), `missing failed-run invariant: ${required}`);
});

test("active Worker must remain the exact pre-attempt single-version 100-percent baseline", () => {
  for (const required of [
    "/workers/scripts/${WORKER_NAME}/deployments",
    "ACTIVE_STATE_CHANGED_UNEXPECTEDLY",
    "current.id !== a.deployment",
    "current.versions.length !== 1",
    "current.versions[0]?.version_id !== a.version",
    "current.versions[0]?.percentage !== 100",
  ]) assert.ok(reconciler.includes(required), `missing active baseline invariant: ${required}`);
});

test("version inventory attribution uses stable GET metadata and fails closed on multiple candidates", () => {
  for (const required of [
    "/workers/scripts/${WORKER_NAME}/versions?per_page=100",
    "page?.items",
    'item?.metadata?.source !== "wrangler"',
    "item.id === a.version",
    "AMBIGUOUS_MULTIPLE_CANDIDATES",
    "NO_POST_ATTEMPT_VERSION_OBSERVED",
    "EXACTLY_ONE_ATTRIBUTABLE_INACTIVE_CANDIDATE",
  ]) assert.ok(reconciler.includes(required), `missing inventory invariant: ${required}`);
  assert.doesNotMatch(reconciler, /workers\/workers\/.+\/versions/);
  assert.doesNotMatch(reconciler, /method\s*:/);
  assert.doesNotMatch(reconciler, /spawnSync|"versions",\s*"upload"|"versions",\s*"deploy"|deleteVersion/);
});

test("candidate detail requires ingest-only binding delta and protected key value remains unobserved", () => {
  for (const required of [
    "/workers/scripts/${WORKER_NAME}/versions/${candidate.id}",
    "CANDIDATE_CONTROL_DB_BINDING_DRIFT",
    "CANDIDATE_VERIFICATION_KEY_BINDING_INVALID",
    "CANDIDATE_INGEST_BINDING_INVALID",
    "CANDIDATE_NON_TARGET_BINDING_DIGEST_DRIFT",
    'ingest[0]?.type !== "plain_text"',
    'ingest[0]?.text !== "true"',
    'key[0]?.type !== "secret_text"',
    "hasOwnProperty.call(key[0], \"text\")",
    "hasOwnProperty.call(key[0], \"value\")",
  ]) assert.ok(reconciler.includes(required), `missing candidate binding invariant: ${required}`);
  assert.doesNotMatch(reconciler, /key\[0\]\.(?:text|value)/);
});

test("candidate digest algorithm remains in parity with activation/preflight canonicalization", () => {
  for (const required of [
    "if (Array.isArray(value)) return value.map(canonical);",
    "Object.keys(value).sort()",
    ".filter((binding) => binding?.name !== INGEST_BINDING)",
    ".map(canonical)",
    "JSON.stringify(left).localeCompare(JSON.stringify(right))",
    "return sha256(JSON.stringify(filtered));",
  ]) assert.ok(reconciler.includes(required), `missing digest parity snippet: ${required}`);
});

test("candidate runtime configuration is tied to unchanged failed-source Worker config", () => {
  assert.match(reconciler, /readFile\("wrangler\.jsonc", "utf8"\)/);
  assert.match(reconciler, /CANDIDATE_COMPATIBILITY_DATE_DRIFT/);
  assert.match(reconciler, /CANDIDATE_COMPATIBILITY_FLAGS_DRIFT/);
  assert.match(reconciler, /CANDIDATE_SCRIPT_IDENTITY_MISSING/);
  assert.match(reconciler, /CANDIDATE_SCRIPT_RUNTIME_CONFIG=EXPECTED/);
});

test("stable script-version API message limitation is explicit rather than guessed", () => {
  assert.match(reconciler, /ATTRIBUTION_MESSAGE_OBSERVABILITY=NOT_AVAILABLE_ON_STABLE_SCRIPT_VERSIONS_API/);
  assert.match(reconciler, /ATTRIBUTION_BASIS=UNIQUE_WRANGLER_VERSION_IN_FAILED_MUTATION_STEP_WINDOW_PLUS_EXACT_CANDIDATE_INVARIANTS/);
  assert.doesNotMatch(reconciler, /workers\/message|annotations/);
});

test("PASS and STOP receipts prove reconciliation is zero-mutation and grants no recovery authority", () => {
  for (const marker of [
    "PHASE5_WORKER_FAILED_UPLOAD_RECONCILE=PASS",
    "PHASE5_WORKER_FAILED_UPLOAD_RECONCILE=STOP",
    "FAILED_ACTIVATION_SOURCE_SHA",
    "RECOVERY_MUTATION_AUTHORIZED=NO",
    "WORKER_MUTATION=NO",
    "WORKER_UPLOAD=NO",
    "WORKER_DEPLOY=NO",
    "WORKER_VERSION_DELETE=NO",
    "WORKER_CONFIG_MUTATION=NO",
    "D1_MUTATION=NO",
    "QUEUE_MUTATION=NO",
    "SECRET_VALUE_OBSERVED=NO",
    "SECRET_MUTATION=NO",
    "CLOUDFLARE_SETTINGS_MUTATION=NO",
    "RPI5_REQUEST=NO",
    "LIVE_AUTHORIZATION=NOT_GRANTED",
  ]) assert.match(reconciler, new RegExp(marker));
});
