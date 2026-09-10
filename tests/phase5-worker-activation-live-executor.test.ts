import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-worker-activate-live.yml";
const EXECUTOR_PATH = "scripts/phase5-rpi5-observation-worker-activate-live.mjs";
const CONTRACT_PATH = ".github/phase5-rpi5-observation-activation-contract.json";
const DOC_PATH = "docs/PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md";

const source = (path: string): string => readFileSync(path, "utf8");
const workflow = source(WORKFLOW_PATH);
const executor = source(EXECUTOR_PATH);
const contract = JSON.parse(source(CONTRACT_PATH)) as {
  mutation_classes: Record<string, Record<string, unknown>>;
};
const doc = source(DOC_PATH);

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

test("candidate is public-safe dispatch data while credentials remain protected secrets", () => {
  assert.match(workflow, /candidate_sha256:/);
  assert.match(workflow, /candidate_manifest_json:/);
  assert.match(workflow, /key_id:/);
  assert.match(workflow, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN: \$\{\{ secrets\.CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /private[_-]?key|secret[_-]?value/i);
});

test("executor binds exact candidate bytes source config and owner authorization tuple", () => {
  for (const required of [
    "CANDIDATE_SHA256_MISMATCH",
    "SOURCE_CONFIG_SHA256_MISMATCH",
    "CANDIDATE_AUTHORIZATION_TUPLE_MISMATCH",
    "AUTHORIZE LIVE PHASE5 WORKER ACTIVATE",
    "candidate_sha256=${a.candidateSha256}",
    "ingest=true",
    "PHASE5_RPI5_OBSERVATION_WORKER_ACTIVATION_CANDIDATE_V1",
    "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("executor requires exact-main CI readonly preflight key provision and Worker baseline", () => {
  for (const required of [
    ".github/workflows/ci.yml",
    ".github/workflows/phase5-rpi5-observation-readonly-preflight.yml",
    ".github/workflows/phase5-rpi5-observation-verification-key-live.yml",
    "CI_GATE_INVALID",
    "PREFLIGHT_GATE_INVALID",
    "VERIFICATION_KEY_PROVISION_GATE_INVALID",
    "WORKER_BASELINE_DRIFT",
    "CONTROL_DB_BINDING_DRIFT",
    "VERIFICATION_KEY_BINDING_DRIFT",
    "NON_TARGET_BINDING_DIGEST_DRIFT",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("upload and deployment are separated by GET verification of the exact returned version", () => {
  const upload = executor.indexOf("await uploadCandidate");
  const verify = executor.indexOf("await assertUploadedCandidate");
  const guard = executor.indexOf("await assertPredeployStillSafe");
  const deploy = executor.indexOf("deployExactCandidate");
  assert.ok(upload >= 0 && verify > upload && guard > verify && deploy > guard);
  assert.equal((executor.match(/"versions", "deploy"/g) ?? []).length, 1);
  assert.doesNotMatch(executor, /\[\s*"deploy"/);
  assert.match(executor, /`${versionId}@100%`/);
  assert.match(executor, /UPLOADED_CANDIDATE_GET_VERIFY=PASS/);
});

test("write credential is scoped only to Wrangler child processes", () => {
  assert.match(executor, /delete env\[key\]/);
  assert.match(executor, /CLOUDFLARE_API_TOKEN: input\("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN"\)/);
  assert.match(executor, /CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID/);
  assert.doesNotMatch(executor, /Authorization: `Bearer \$\{input\("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN"\)\}`/);
});

test("postdeploy verification proves exact active version and no cross-class mutation path", () => {
  for (const required of [
    "POSTDEPLOY_EXACT_VERSION_INVALID",
    "ACTIVE_TRAFFIC_PERCENT=100",
    "INGEST_BINDING=PLAIN_TEXT_TRUE",
    "VERIFICATION_KEY_BINDING=PRESENT_PROTECTED_UNCHANGED",
    "SECRET_VALUE_OBSERVED=NO",
    "CONTROL_DB_BINDING=UNCHANGED",
    "NON_TARGET_BINDING_INVENTORY=UNCHANGED",
    "ROUTE_CUSTOM_DOMAIN_TRIGGER_QUEUE_MUTATION=NO",
    "D1_MUTATION=NO",
    "SECRET_MUTATION=NO",
    "RPI5_MUTATION=NO",
    "PHASE5_WORKER_ACTIVATE=PASS",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(executor, /secret\s+put|d1\s+migrations\s+apply|triggers\s+deploy/);
});

test("machine and operator contracts name the same concrete Worker executor", () => {
  const worker = contract.mutation_classes.WORKER_ACTIVATE;
  assert.equal(worker.executor_workflow, WORKFLOW_PATH);
  assert.equal(worker.executor_script, EXECUTOR_PATH);
  assert.equal(worker.github_environment, "production-worker-activation-live");
  assert.equal(worker.workers_read_secret_binding, "CLOUDFLARE_API_TOKEN");
  assert.equal(worker.workers_write_secret_binding, "CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN");
  assert.equal(worker.candidate_manifest_dispatch_input, "candidate_manifest_json");
  assert.equal(worker.direct_wrangler_deploy_forbidden, true);
  assert.equal(worker.automatic_retry_rollback_cleanup_or_alternate_mutation, false);

  for (const required of [
    "phase5-rpi5-observation-worker-activate-live.yml",
    "phase5-rpi5-observation-worker-activate-live.mjs",
    "production-worker-activation-live",
    "CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN",
    "WORKER_VERSION_UPLOAD_STARTED=YES",
    "UPLOADED_CANDIDATE_GET_VERIFY=PASS",
    "EXACT_VERIFIED_VERSION_DEPLOY_STARTED=YES",
    "PHASE5_WORKER_ACTIVATE=PASS",
  ]) assert.match(doc, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});
