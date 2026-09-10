import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-verification-key-live.yml";
const EXECUTOR_PATH = "scripts/phase5-rpi5-observation-verification-key-live.mjs";
const CONTRACT_PATH = ".github/phase5-rpi5-observation-activation-contract.json";
const DOC_PATH = "docs/PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const workflow = source(WORKFLOW_PATH);
const executor = source(EXECUTOR_PATH);
const contract = JSON.parse(source(CONTRACT_PATH)) as {
  mutation_classes: Record<string, Record<string, unknown>>;
  future_owner_command_templates: Record<string, string>;
};
const doc = source(DOC_PATH);

test("verification-key executor is manual-only and environment gated", () => {
  assert.ok(workflow.includes("on:\n  workflow_dispatch:"));
  assert.ok(!workflow.includes("\n  push:"));
  assert.ok(!workflow.includes("\n  pull_request:"));
  assert.ok(workflow.includes("permissions:\n  contents: read\n  actions: read"));
  assert.ok(workflow.includes("environment: production-verification-key-live"));
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /ref: \$\{\{ inputs\.approved_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
});

test("protected registry and write token are secrets, never dispatch inputs", () => {
  assert.match(workflow, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN: \$\{\{ secrets\.CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN \}\}/);
  assert.match(workflow, /CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE: \$\{\{ secrets\.CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE \}\}/);
  assert.doesNotMatch(workflow, /inputs:\n(?:.|\n)*publicKeyBase64url/);
  assert.doesNotMatch(workflow, /inputs:\n(?:.|\n)*verification_key_registry/);
});

test("executor validates the exact one-key Phase 5 registry without printing secret material", () => {
  assert.match(executor, /control-phase5-rpi5-verification-keys-v1/);
  assert.match(executor, /registry\.keys\.length !== 1/);
  assert.match(executor, /entry\.keyId !== a\.keyId/);
  assert.match(executor, /PUBLIC_KEY_PATTERN/);
  assert.match(executor, /decoded\.length !== 32/);
  assert.match(executor, /VERIFICATION_KEY_REGISTRY=VALID key_id=\$\{a\.keyId\} key_count=1/);
  assert.doesNotMatch(executor, /console\.(?:log|error)\([^\n]*publicKeyBase64url/);
});

test("executor binds exact main CI preflight and Worker baseline", () => {
  for (const required of [
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
    "PREWRITE_BASELINE_DRIFT",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("authorization consumes immediately before exactly one secret put", () => {
  const marker = executor.indexOf('console.log("AUTHORIZATION_CONSUMED=YES")');
  const mutation = executor.indexOf('spawnSync(wrangler(), ["secret", "put", BINDING, "--name", WORKER_NAME]');
  assert.ok(marker >= 0 && mutation > marker);
  assert.equal((executor.match(/spawnSync\(wrangler\(\), \["secret", "put"/g) ?? []).length, 1);
  assert.match(executor, /input: input\("CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE"\)/);
  assert.match(executor, /CLOUDFLARE_API_TOKEN: input\("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN"\)/);
  assert.match(executor, /POST_MUTATION_STATE=REVIEW_REQUIRED/);
  assert.match(executor, /NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES/);
  assert.doesNotMatch(executor, /while\s*\(/);
});

test("postwrite requires only the protected secret addition and no ingest activation", () => {
  assert.match(executor, /state\.deployment === baseline\.deployment \|\| state\.version === baseline\.version/);
  assert.match(executor, /target\[0\]\?\.type !== "secret_text"/);
  assert.match(executor, /Object\.prototype\.hasOwnProperty\.call\(target\[0\], "text"\)/);
  assert.match(executor, /bindingSnapshot\(remaining\) !== bindingSnapshot\(baseline\.bindings\)/);
  assert.match(executor, /NON_SECRET_BINDING_INVENTORY=UNCHANGED/);
  assert.match(executor, /INGEST_ACTIVATION=NO/);
  assert.match(executor, /D1_MUTATION=NO/);
  assert.match(executor, /QUEUE_MUTATION=NO/);
  assert.match(executor, /SECRET_VALUE_OBSERVED=NO/);
});

test("machine and operator contracts bind the same verification-key executor", () => {
  const key = contract.mutation_classes.VERIFICATION_KEY_PROVISION;
  assert.equal(key.executor_workflow, WORKFLOW_PATH);
  assert.equal(key.github_environment, "production-verification-key-live");
  assert.equal(key.requires_exact_ci_run, true);
  assert.equal(key.requires_exact_worker_deployment, true);
  assert.equal(key.requires_exact_worker_version, true);
  assert.equal(key.workers_write_secret_binding, "CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN");
  assert.equal(key.registry_secret_binding, "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE");
  assert.equal(key.registry_version, "control-phase5-rpi5-verification-keys-v1");
  assert.equal(key.registry_exact_key_count, 1);
  assert.equal(key.wrangler_secret_put_creates_and_deploys_new_worker_version, true);
  assert.equal(key.automatic_retry_rollback_cleanup_or_alternate_mutation, false);

  const command = contract.future_owner_command_templates.VERIFICATION_KEY_PROVISION;
  for (const field of ["source_sha=<sha>", "ci_run=<ci_run_id>", "preflight_run=<run_id>", "deployment=<deployment_id>", "version=<version_id>", "key_id=<public_key_id>"]) {
    assert.match(command, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const required of [
    "phase5-rpi5-observation-verification-key-live.yml",
    "production-verification-key-live",
    "CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN",
    "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE",
    "SECRET_PROVISION_STARTED=YES",
    "POST_MUTATION_STATE=REVIEW_REQUIRED",
    "secret_text",
  ]) assert.match(doc, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
