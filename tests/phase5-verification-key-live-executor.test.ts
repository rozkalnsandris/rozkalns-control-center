import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-verification-key-live.yml";
const EXECUTOR_PATH = "scripts/phase5-rpi5-observation-verification-key-live.mjs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const workflow = source(WORKFLOW_PATH);
const executor = source(EXECUTOR_PATH);

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
