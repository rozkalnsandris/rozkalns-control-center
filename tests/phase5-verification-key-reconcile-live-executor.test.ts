import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-verification-key-reconcile-live.yml";
const EXECUTOR_PATH = "scripts/phase5-rpi5-observation-verification-key-reconcile-live.mjs";
const CONTRACT_PATH = ".github/phase5-rpi5-observation-verification-key-reconcile-contract.json";
const DOC_PATH = "docs/PHASE5_RPI5_OBSERVATION_VERIFICATION_KEY_RECONCILIATION.md";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const workflow = source(WORKFLOW_PATH);
const executor = source(EXECUTOR_PATH);
const contract = JSON.parse(source(CONTRACT_PATH)) as {
  contract: string;
  authority: Record<string, unknown>;
  preconditions: Record<string, unknown>;
  executor: Record<string, unknown>;
  mutation: Record<string, unknown>;
  postwrite: Record<string, unknown>;
  future_owner_command_template: string;
};
const doc = source(DOC_PATH);

test("post-activation key reconcile is manual-only and environment gated", () => {
  assert.ok(workflow.includes("on:\n  workflow_dispatch:"));
  assert.ok(!workflow.includes("\n  push:"));
  assert.ok(!workflow.includes("\n  pull_request:"));
  assert.ok(workflow.includes("permissions:\n  contents: read\n  actions: read"));
  assert.ok(workflow.includes("environment: production-verification-key-live"));
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /ref: \$\{\{ inputs\.approved_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
});

test("public RPi5 receipt fields are inputs while write credentials remain secrets", () => {
  assert.match(workflow, /public_key_base64url:/);
  assert.match(workflow, /key_id:/);
  assert.match(workflow, /CLOUDFLARE_WORKERS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN: \$\{\{ secrets\.CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE/);
  assert.doesNotMatch(workflow, /verification_key_registry:/);
});

test("executor validates canonical Ed25519 public key and binds its raw-byte sha256", () => {
  assert.match(executor, /PUBLIC_KEY_PATTERN/);
  assert.match(executor, /Buffer\.from\(value, "base64url"\)/);
  assert.match(executor, /decoded\.length !== 32/);
  assert.match(executor, /decoded\.toString\("base64url"\) !== value/);
  assert.match(executor, /createHash\("sha256"\)\.update\(decoded\)\.digest\("hex"\)/);
  assert.match(executor, /public_key_sha256=\$\{publicKeySha256\}/);
  assert.match(executor, /version: REGISTRY_VERSION/);
  assert.match(executor, /keys: \[\{ keyId: a\.keyId, publicKeyBase64url: a\.publicKeyBase64url \}\]/);
  assert.doesNotMatch(executor, /console\.(?:log|error)\([^\n]*publicKeyBase64url/);
});

test("executor binds exact main CI and first-attempt post-activation verifier", () => {
  for (const required of [
    ".github/workflows/ci.yml",
    ".github/workflows/phase5-rpi5-observation-worker-post-activation-verify.yml",
    "Phase 5 RPi5 observation Worker post-activation GET-only verify",
    "MAIN_SHA_DRIFT",
    "CI_GATE_INVALID",
    "POST_ACTIVATION_VERIFY_GATE_INVALID",
    "run_attempt",
    "WORKER_BASELINE_DRIFT",
    "PREWRITE_BASELINE_DRIFT",
  ]) assert.match(executor, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("baseline requires active ingest protected target and exact CONTROL_DB", () => {
  assert.match(executor, /INGEST_BINDING/);
  assert.match(executor, /ingest\[0\]\?\.type !== "plain_text"/);
  assert.match(executor, /ingest\[0\]\?\.text !== "true"/);
  assert.match(executor, /VERIFICATION_KEY_BASELINE_DRIFT/);
  assert.match(executor, /target\[0\]\?\.type !== "secret_text"/);
  assert.match(executor, /Object\.prototype\.hasOwnProperty\.call\(target\[0\], "text"\)/);
  assert.match(executor, /Object\.prototype\.hasOwnProperty\.call\(target\[0\], "value"\)/);
  assert.match(executor, /CONTROL_DB_BINDING_DRIFT/);
  assert.match(executor, /COMPATIBILITY_DATE_DRIFT/);
  assert.match(executor, /COMPATIBILITY_FLAGS_DRIFT/);
});

test("authorization is consumed before exactly one target secret put", () => {
  const marker = executor.indexOf('console.log("AUTHORIZATION_CONSUMED=YES")');
  const mutation = executor.indexOf('spawnSync(wrangler(), ["secret", "put", BINDING, "--name", WORKER_NAME]');
  assert.ok(marker >= 0 && mutation > marker);
  assert.equal((executor.match(/spawnSync\(wrangler\(\), \["secret", "put"/g) ?? []).length, 1);
  assert.match(executor, /input: registry/);
  assert.match(executor, /CLOUDFLARE_API_TOKEN: input\("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN"\)/);
  assert.match(executor, /POST_MUTATION_STATE=REVIEW_REQUIRED/);
  assert.match(executor, /NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES/);
  assert.doesNotMatch(executor, /while\s*\(/);
});

test("postwrite requires a new active version while preserving active ingest and every non-target binding", () => {
  assert.match(executor, /state\.deployment === baseline\.deployment \|\| state\.version === baseline\.version/);
  assert.match(executor, /bindingSnapshot\(withoutTarget\(state\.bindings\)\) !== bindingSnapshot\(withoutTarget\(baseline\.bindings\)\)/);
  assert.match(executor, /POSTWRITE_BINDING_DRIFT/);
  assert.match(executor, /POSTWRITE_RUNTIME_DRIFT/);
  assert.match(executor, /INGEST_BINDING=PLAIN_TEXT_TRUE_UNCHANGED/);
  assert.match(executor, /SECRET_VALUE_OBSERVED=NO/);
  assert.match(executor, /NON_TARGET_BINDING_INVENTORY=UNCHANGED/);
  assert.match(executor, /CONTROL_DB_BINDING=VALID_UNCHANGED/);
  assert.match(executor, /D1_MUTATION=NO/);
  assert.match(executor, /QUEUE_MUTATION=NO/);
  assert.match(executor, /ROUTE_DNS_ACCESS_RPI5_MUTATION=NO/);
});

test("machine contract and operator doc describe the same bounded reconcile path", () => {
  assert.equal(contract.contract, "PHASE5_RPI5_OBSERVATION_VERIFICATION_KEY_RECONCILE_V1");
  assert.equal(contract.authority.live_authority_granted, false);
  assert.equal(contract.preconditions.requires_successful_first_attempt_post_activation_verify, true);
  assert.equal(contract.executor.workflow, WORKFLOW_PATH);
  assert.equal(contract.executor.script, EXECUTOR_PATH);
  assert.equal(contract.executor.registry_secret_binding_required, false);
  assert.equal(contract.executor.authorization_binds_public_key_sha256, true);
  assert.equal(contract.mutation.requires_separate_owner_live_authorization, true);
  assert.equal(contract.mutation.wrangler_secret_put_creates_and_deploys_new_worker_version, true);
  assert.equal(contract.mutation.automatic_retry_rollback_cleanup_or_alternate_mutation, false);
  assert.equal(contract.postwrite.requires_ingest_binding_unchanged_true, true);
  assert.equal(contract.postwrite.requires_non_target_binding_inventory_unchanged, true);

  for (const field of [
    "source_sha=<sha>",
    "ci_run=<ci_run_id>",
    "post_activation_verify_run=<run_id>",
    "deployment=<deployment_id>",
    "version=<version_id>",
    "key_id=<public_key_id>",
    "public_key_sha256=<sha256_of_raw_ed25519_public_key>",
  ]) assert.match(contract.future_owner_command_template, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const required of [
    WORKFLOW_PATH,
    EXECUTOR_PATH,
    "production-verification-key-live",
    "wrangler secret put CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS",
    "POST_MUTATION_STATE=REVIEW_REQUIRED",
    "Merge is not LIVE authorization",
  ]) assert.match(doc, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
