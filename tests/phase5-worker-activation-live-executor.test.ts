import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-worker-activate-live.yml";
const EXECUTOR_PATH = "scripts/phase5-rpi5-observation-worker-activate-live.mjs";
const CONTRACT_PATH = ".github/phase5-rpi5-observation-worker-activation-executor-contract.json";
const DOC_PATH = "docs/PHASE5_RPI5_OBSERVATION_WORKER_ACTIVATION_EXECUTOR.md";
const WRANGLER_PATH = "wrangler.jsonc";

const source = (path: string): string => readFileSync(path, "utf8");
const workflow = source(WORKFLOW_PATH);
const executor = source(EXECUTOR_PATH);
const contract = JSON.parse(source(CONTRACT_PATH)) as Record<string, unknown> & {
  authority: Record<string, unknown>;
  executor: Record<string, unknown>;
  protected_credentials: Record<string, unknown>;
  prewrite_gates: Record<string, unknown>;
  mutation_ceiling: Record<string, unknown>;
  between_upload_and_deploy: Record<string, unknown>;
  postdeploy: Record<string, unknown>;
};
const doc = source(DOC_PATH);
const wrangler = source(WRANGLER_PATH);

test("Worker activation executor is manual-only and dedicated-environment gated", () => {
  assert.ok(workflow.includes("on:\n  workflow_dispatch:"));
  assert.ok(!workflow.includes("\n  push:"));
  assert.ok(!workflow.includes("\n  pull_request:"));
  assert.ok(workflow.includes("permissions:\n  contents: read\n  actions: read"));
  assert.match(workflow, /environment: production-worker-activation-live/);
  assert.match(workflow, /ref: \$\{\{ inputs\.approved_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("build and all readonly prerequisites occur before the executor can consume LIVE authority", () => {
  const install = workflow.indexOf("run: npm ci");
  const build = workflow.indexOf("run: npm run build");
  const execute = workflow.indexOf("run: node scripts/phase5-rpi5-observation-worker-activate-live.mjs");
  assert.ok(install >= 0 && build > install && execute > build);
  assert.match(workflow, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_D1_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_READ_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN: \$\{\{ secrets\.CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN \}\}/);
});

test("candidate is public-safe dispatch data while secret/private material is not an input", () => {
  for (const input of [
    "approved_sha:",
    "expected_ci_run:",
    "expected_preflight_run:",
    "expected_deployment:",
    "expected_version:",
    "candidate_sha256:",
    "candidate_manifest_json:",
    "key_id:",
    "authorization:",
  ]) assert.match(workflow, new RegExp(input));
  assert.doesNotMatch(workflow, /private[_-]?key|secret[_-]?value/i);
});

test("executor binds exact candidate bytes, source config and owner authorization tuple", () => {
  for (const required of [
    "CANDIDATE_SHA256_MISMATCH",
    "SOURCE_CONFIG_SHA256_MISMATCH",
    "CANDIDATE_AUTHORIZATION_TUPLE_MISMATCH",
    "AUTHORIZE LIVE PHASE5 WORKER ACTIVATE",
    "candidate_sha256=${a.candidateSha256}",
    "ingest=true",
    "PHASE5_RPI5_OBSERVATION_WORKER_ACTIVATION_CANDIDATE_V1",
    "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED",
    "CANDIDATE_CONFIG_DELTA_INVALID",
    "SOURCE_CONFIG_DELTA=INGEST_ONLY",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("executor requires exact-main CI/preflight, ancestor verification-key provision and Worker baseline", () => {
  for (const required of [
    ".github/workflows/ci.yml",
    ".github/workflows/phase5-rpi5-observation-readonly-preflight.yml",
    ".github/workflows/phase5-rpi5-observation-verification-key-live.yml",
    "CI_GATE_INVALID",
    "PREFLIGHT_GATE_INVALID",
    "VERIFICATION_KEY_PROVISION_GATE_INVALID",
    "VERIFICATION_KEY_PROVISION_SOURCE_INVALID",
    "VERIFICATION_KEY_PROVISION_SOURCE_NOT_ANCESTOR",
    "VERIFICATION_KEY_PROVISION_SOURCE_ANCESTRY_CHECK_FAILED",
    "VERIFICATION_KEY_PROVISION_SOURCE_ANCESTRY=PASS",
    "WORKER_BASELINE_DRIFT",
    "CONTROL_DB_BINDING_DRIFT",
    "VERIFICATION_KEY_BINDING_DRIFT",
    "NON_TARGET_BINDING_DIGEST_DRIFT",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("executor independently proves current D1 prerequisite with SELECT-only queries", () => {
  for (const required of [
    "CLOUDFLARE_D1_READ_TOKEN_REQUIRED",
    "D1_RESOURCE_IDENTITY_INVALID",
    "D1_PHASE5_MIGRATIONS_NOT_PRESENT_VALID",
    "D1_PHASE5_SCHEMA_NOT_PRESENT_VALID",
    "0010_webhook_observability_hot_index.sql",
    "0011_rpi5_observation_replay_claims.sql",
    "0012_rpi5_production_visibility_projection.sql",
    "0013_rpi5_observation_atomic_acceptance.sql",
    "SELECT replay_key, replay_expires_at_ms, claimed_at_ms, claim_token",
    "SELECT project_id, repository, observed_at_ms, stored_at_ms",
    "D1_PHASE5_GATE=PRESENT_VALID_0010_THROUGH_0013",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(executor, /if \(!sql\.startsWith\("SELECT "\) \|\| sql\.includes\(";"\)\)/);
  assert.match(executor, /rows_written \?\? 0/);
  assert.match(executor, /changes \?\? 0/);
});

test("authorization is consumed immediately before exactly one version upload", () => {
  const marker = executor.indexOf('console.log("AUTHORIZATION_CONSUMED=YES")');
  const upload = executor.indexOf('"versions", "upload"');
  assert.ok(marker >= 0 && upload > marker);
  assert.equal((executor.match(/"versions", "upload"/g) ?? []).length, 1);
  assert.match(executor, /WORKER_VERSION_UPLOAD_STARTED=YES/);
  assert.match(executor, /POST_MUTATION_STATE=REVIEW_REQUIRED/);
  assert.match(executor, /NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES/);
  assert.doesNotMatch(executor, /while\s*\(/);
});

test("upload and deployment are separated by GET verification and a repeated drift guard", () => {
  const upload = executor.indexOf("await uploadCandidate");
  const verify = executor.indexOf("await assertUploadedCandidate");
  const guard = executor.indexOf("await assertPredeployStillSafe");
  const deploy = executor.indexOf("deployExactCandidate(a, versionId);");
  assert.ok(upload >= 0 && verify > upload && guard > verify && deploy > guard);
  assert.equal((executor.match(/"versions", "deploy"/g) ?? []).length, 1);
  assert.ok(executor.includes("`${versionId}@100%`"));
  assert.match(executor, /UPLOADED_CANDIDATE_GET_VERIFY=PASS/);
  assert.match(executor, /PREDEPLOY_DRIFT_GUARD=PASS/);
});

test("write credential is scoped only to Wrangler child processes", () => {
  assert.match(executor, /delete env\[key\]/);
  assert.match(executor, /CLOUDFLARE_API_TOKEN: input\("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN"\)/);
  assert.match(executor, /CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID/);
  assert.doesNotMatch(executor, /Authorization: `Bearer \$\{input\("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN"\)\}`/);
});

test("no cross-class mutation command exists", () => {
  assert.doesNotMatch(executor, /"triggers",\s*"deploy"/);
  assert.doesNotMatch(executor, /"secret",\s*"put"/);
  assert.doesNotMatch(executor, /"d1",\s*"migrations",\s*"apply"/);
  assert.doesNotMatch(executor, /"queues?",\s*(?:"create"|"delete"|"update")/);
  assert.match(executor, /TRIGGER_ROUTE_CUSTOM_DOMAIN_QUEUE_MUTATION_PATH=ABSENT/);
  assert.match(executor, /--experimental-provision=false/);
  assert.match(executor, /--experimental-auto-create=false/);
});

test("postdeploy verification proves the exact active version and protected prerequisites", () => {
  for (const required of [
    "POSTDEPLOY_EXACT_VERSION_INVALID",
    "ACTIVE_TRAFFIC_PERCENT=100",
    "INGEST_BINDING=PLAIN_TEXT_TRUE",
    "VERIFICATION_KEY_BINDING=PRESENT_PROTECTED_UNCHANGED",
    "SECRET_VALUE_OBSERVED=NO",
    "CONTROL_DB_BINDING=UNCHANGED",
    "NON_TARGET_BINDING_INVENTORY=UNCHANGED",
    "D1_MUTATION=NO",
    "SECRET_MUTATION=NO",
    "RPI5_MUTATION=NO",
    "PHASE5_WORKER_ACTIVATE=PASS",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("machine contract binds the same fail-closed executor and mutation ceiling", () => {
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.contract, "PHASE5_RPI5_OBSERVATION_WORKER_ACTIVATION_EXECUTOR_V1");
  assert.equal(contract.authority.source_contract_only, true);
  assert.equal(contract.authority.live_authority_granted, false);
  assert.equal(contract.authority.merge_authorizes_live, false);
  assert.equal(contract.authority.authorization_consumed_at, "FIRST_WORKER_VERSION_UPLOAD");
  assert.equal(contract.executor.workflow, WORKFLOW_PATH);
  assert.equal(contract.executor.script, EXECUTOR_PATH);
  assert.equal(contract.executor.github_environment, "production-worker-activation-live");
  assert.equal(contract.executor.build_before_authorization_consumption, true);
  assert.equal(contract.protected_credentials.d1_read_secret_binding, "CLOUDFLARE_D1_READ_TOKEN");
  assert.equal(contract.protected_credentials.workers_scripts_write_secret_binding, "CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN");
  assert.equal(contract.prewrite_gates.successful_first_attempt_main_verification_key_provision_run_ancestor_of_approved_sha, true);
  assert.equal(contract.prewrite_gates.candidate_delta, "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED_PLAIN_TEXT_TRUE_ONLY");
  assert.equal(contract.prewrite_gates.d1_migrations, "0010_THROUGH_0013_PRESENT_VALID");
  assert.equal(contract.mutation_ceiling.version_upload_count, 1);
  assert.equal(contract.mutation_ceiling.version_deploy_count, 1);
  assert.equal(contract.mutation_ceiling.direct_wrangler_deploy_forbidden, true);
  assert.equal(contract.mutation_ceiling.wrangler_triggers_deploy_forbidden, true);
  assert.equal(contract.mutation_ceiling.d1_mutation, false);
  assert.equal(contract.mutation_ceiling.secret_mutation, false);
  assert.equal(contract.mutation_ceiling.queue_mutation, false);
  assert.equal(contract.between_upload_and_deploy.repeat_exact_main_ci_preflight_and_ancestor_provision_evidence, true);
  assert.equal(contract.between_upload_and_deploy.on_any_mismatch, "STOP_NO_DEPLOY");
  assert.equal(contract.postdeploy.secret_value_observed, false);
});

test("operator doc converges on the concrete executor and LIVE boundary", () => {
  for (const required of [
    "phase5-rpi5-observation-worker-activate-live.yml",
    "phase5-rpi5-observation-worker-activate-live.mjs",
    "production-worker-activation-live",
    "CLOUDFLARE_D1_READ_TOKEN",
    "CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN",
    "WORKER_VERSION_UPLOAD_STARTED=YES",
    "UPLOADED_CANDIDATE_GET_VERIFY=PASS",
    "PREDEPLOY_DRIFT_GUARD=PASS",
    "EXACT_VERIFIED_VERSION_DEPLOY_STARTED=YES",
    "TRIGGER_ROUTE_CUSTOM_DOMAIN_QUEUE_MUTATION_PATH=ABSENT",
    "PHASE5_WORKER_ACTIVATE=PASS",
    "does not grant LIVE authority",
  ]) assert.match(doc, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("repository production config remains dormant in #615 source-only scope", () => {
  assert.doesNotMatch(wrangler, /CONTROL_RPI5_OBSERVATION_INGEST_ENABLED/);
});
