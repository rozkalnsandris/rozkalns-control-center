import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-worker-post-activation-verify.yml";
const VERIFIER_PATH = "scripts/phase5-rpi5-observation-worker-post-activation-verify.mjs";
const CONTRACT_PATH = ".github/phase5-rpi5-observation-worker-post-activation-verifier-contract.json";
const DOC_PATH = "docs/PHASE5_RPI5_OBSERVATION_WORKER_POST_ACTIVATION_VERIFICATION.md";

const source = (path: string): string => readFileSync(path, "utf8");
const workflow = source(WORKFLOW_PATH);
const verifier = source(VERIFIER_PATH);
const doc = source(DOC_PATH);
const contract = JSON.parse(source(CONTRACT_PATH)) as {
  schema_version: number;
  contract: string;
  authority: Record<string, unknown>;
  verifier: Record<string, unknown>;
  protected_credentials: Record<string, unknown>;
  verification_gates: Record<string, unknown>;
  zero_mutation: Record<string, unknown>;
  receipt: Record<string, unknown>;
};

test("post-activation verifier workflow is manual and read-only credential scoped", () => {
  assert.ok(workflow.includes("on:\n  workflow_dispatch:"));
  assert.ok(!workflow.includes("\n  push:"));
  assert.ok(!workflow.includes("\n  pull_request:"));
  assert.ok(workflow.includes("permissions:\n  contents: read\n  actions: read"));
  assert.match(workflow, /environment: production-readonly-reconcile/);
  assert.match(workflow, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN|CLOUDFLARE_D1_READ_TOKEN/);
  assert.match(workflow, /persist-credentials: false/);
});

test("workflow binds exact source, CI, deployment, version and non-target binding digest", () => {
  for (const required of [
    "approved_sha:",
    "expected_ci_run:",
    "expected_deployment:",
    "expected_version:",
    "expected_non_target_bindings_sha256:",
  ]) assert.match(workflow, new RegExp(required));
  assert.match(workflow, /ref: \$\{\{ inputs\.approved_sha \}\}/);
  assert.match(workflow, /phase5-rpi5-observation-worker-post-activation-verify\.mjs/);
});

test("verifier revalidates exact-main CI and only uses Workers GET surfaces", () => {
  for (const required of [
    "/branches/main",
    "/actions/runs/${a.ciRun}",
    ".github/workflows/ci.yml",
    "CI_GATE_INVALID",
    "/workers/scripts/${WORKER_NAME}/deployments",
    "/workers/scripts/${WORKER_NAME}/versions/${a.version}",
  ]) assert.ok(verifier.includes(required), `missing verifier invariant: ${required}`);
  assert.doesNotMatch(verifier, /method\s*:/);
  assert.doesNotMatch(verifier, /spawnSync|wrangler|versions["', ]+upload|versions["', ]+deploy|triggers["', ]+deploy/);
});

test("verifier requires the exact post-activation binding state without dormant-baseline reuse", () => {
  for (const required of [
    "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED",
    "INGEST_BINDING_NOT_ACTIVE",
    'ingest[0]?.type !== "plain_text"',
    'ingest[0]?.text !== "true"',
    "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS",
    "VERIFICATION_KEY_BINDING_INVALID",
    'key[0]?.type !== "secret_text"',
    "CONTROL_DB_BINDING_DRIFT",
    "NON_TARGET_BINDING_DIGEST_DRIFT",
  ]) assert.ok(verifier.includes(required), `missing binding invariant: ${required}`);
  assert.doesNotMatch(verifier, /ABSENT_DORMANT|EXPLICIT_FALSE_DORMANT|INGEST_ALREADY_ACTIVE/);
});

test("verification-key material is classified but never read as a value", () => {
  assert.match(verifier, /hasOwnProperty\.call\(key\[0\], "text"\)/);
  assert.match(verifier, /hasOwnProperty\.call\(key\[0\], "value"\)/);
  assert.match(verifier, /SECRET_VALUE_OBSERVED=NO/);
  assert.doesNotMatch(verifier, /key\[0\]\.(?:text|value)/);
});

test("runtime compatibility configuration is tied to current source", () => {
  assert.match(verifier, /readFile\("wrangler\.jsonc", "utf8"\)/);
  assert.match(verifier, /COMPATIBILITY_DATE_DRIFT/);
  assert.match(verifier, /COMPATIBILITY_FLAGS_DRIFT/);
  assert.match(verifier, /SCRIPT_IDENTITY_MISSING/);
  assert.match(verifier, /SCRIPT_RUNTIME_CONFIG=EXPECTED/);
});

test("PASS and STOP receipts explicitly prove zero mutation", () => {
  for (const marker of [
    "PHASE5_WORKER_POST_ACTIVATION_VERIFY=PASS",
    "PHASE5_WORKER_POST_ACTIVATION_VERIFY=STOP",
    "WORKER_MUTATION=NO",
    "WORKER_UPLOAD=NO",
    "WORKER_DEPLOY=NO",
    "WORKER_CONFIG_MUTATION=NO",
    "D1_MUTATION=NO",
    "QUEUE_MUTATION=NO",
    "SECRET_MUTATION=NO",
    "CLOUDFLARE_SETTINGS_MUTATION=NO",
    "RPI5_REQUEST=NO",
    "LIVE_AUTHORIZATION=NOT_GRANTED",
  ]) assert.match(verifier, new RegExp(marker));
});

test("machine contract matches the concrete read-only verifier", () => {
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.contract, "PHASE5_RPI5_OBSERVATION_WORKER_POST_ACTIVATION_VERIFIER_V1");
  assert.equal(contract.authority.source_contract_only, true);
  assert.equal(contract.authority.read_only_verifier, true);
  assert.equal(contract.authority.live_authority_granted, false);
  assert.equal(contract.authority.merge_authorizes_live, false);
  assert.equal(contract.authority.authorization_consumed, false);
  assert.equal(contract.verifier.workflow, WORKFLOW_PATH);
  assert.equal(contract.verifier.script, VERIFIER_PATH);
  assert.equal(contract.verifier.github_environment, "production-readonly-reconcile");
  assert.equal(contract.protected_credentials.workers_read_secret_binding, "CLOUDFLARE_API_TOKEN");
  assert.equal(contract.protected_credentials.workers_write_credential, "ABSENT");
  assert.equal(contract.protected_credentials.d1_credential, "ABSENT");
  assert.equal(contract.verification_gates.active_traffic_percent, 100);
  assert.equal(contract.verification_gates.pre_activation_dormant_ingest_assumption_reused, false);
  assert.equal(contract.zero_mutation.worker_upload, false);
  assert.equal(contract.zero_mutation.worker_deploy, false);
  assert.equal(contract.zero_mutation.d1_mutation, false);
  assert.equal(contract.zero_mutation.queue_mutation, false);
  assert.equal(contract.zero_mutation.secret_value_observation, false);
  assert.equal(contract.receipt.pass_marker, "PHASE5_WORKER_POST_ACTIVATION_VERIFY=PASS");
});

test("operator doc preserves source/live separation and GET-only scope", () => {
  for (const required of [
    "GET-only",
    "production-readonly-reconcile",
    "expected active Worker deployment ID",
    "expected active Worker version ID",
    "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED",
    "PRESENT_PROTECTED_SECRET_TEXT_VALUE_UNOBSERVED",
    "WORKER_UPLOAD=NO",
    "WORKER_DEPLOY=NO",
    "LIVE_AUTHORIZATION=NOT_GRANTED",
    "does not prove that production Worker activation has occurred",
  ]) assert.match(doc, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});
