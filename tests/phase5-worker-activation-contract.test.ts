import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CONTRACT_PATH = ".github/phase5-rpi5-observation-activation-contract.json";
const DOC_PATH = "docs/PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md";
const CANDIDATE_PATH = "src/shared/phase5-worker-activation-candidate.ts";
const WRANGLER_PATH = "wrangler.jsonc";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const contract = JSON.parse(source(CONTRACT_PATH)) as {
  mutation_classes: Record<string, Record<string, unknown>>;
  future_owner_command_templates: Record<string, string>;
};

const worker = contract.mutation_classes.WORKER_ACTIVATE;
const doc = source(DOC_PATH);
const candidate = source(CANDIDATE_PATH);
const wrangler = source(WRANGLER_PATH);

test("Worker activation machine contract binds exact candidate and baseline identity", () => {
  assert.equal(worker.requires_separate_owner_live_authorization, true);
  assert.equal(worker.requires_exact_source_sha, true);
  assert.equal(worker.requires_exact_ci_run, true);
  assert.equal(worker.requires_exact_preflight_run, true);
  assert.equal(worker.requires_expected_remote_state_match, true);
  assert.equal(worker.requires_exact_worker_deployment, true);
  assert.equal(worker.requires_exact_worker_version, true);
  assert.equal(worker.requires_prior_d1_gate_satisfied, true);
  assert.equal(worker.requires_prior_verification_key_gate_satisfied, true);
  assert.equal(worker.candidate_manifest_validator, CANDIDATE_PATH);
  assert.equal(
    worker.candidate_manifest_contract,
    "PHASE5_RPI5_OBSERVATION_WORKER_ACTIVATION_CANDIDATE_V1",
  );
  assert.equal(worker.candidate_manifest_schema_version, 1);
  assert.equal(worker.candidate_manifest_sha256_must_equal_authorization, true);
  assert.equal(worker.candidate_source_config_sha256_required, true);
  assert.deepEqual(worker.baseline_ingest_binding_states, ["ABSENT", "PRESENT_FALSE"]);
});

test("Worker activation permits only exact ingest activation with protected prerequisites unchanged", () => {
  assert.equal(worker.target_ingest_binding, "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED");
  assert.equal(worker.target_ingest_binding_type, "plain_text");
  assert.equal(worker.target_ingest_binding_value, "true");
  assert.match(String(worker.verification_key_prerequisite), /secret_text/i);
  assert.match(String(worker.verification_key_prerequisite), /VALUE_UNOBSERVED/);
  assert.match(String(worker.d1_prerequisite), /CONTROL_DB/);
  assert.match(String(worker.d1_prerequisite), /0010_THROUGH_0013_PRESENT_VALID/);
  assert.equal(worker.non_target_binding_inventory_digest_unchanged, true);
  assert.equal(worker.routes_custom_domains_triggers_and_queues_unchanged, true);
});

test("Worker activation lifecycle is upload then GET verify then exact version deploy", () => {
  assert.equal(
    worker.version_strategy,
    "UPLOAD_NEW_VERSION_THEN_GET_VERIFY_THEN_DEPLOY_EXACT_VERSION_100_PERCENT",
  );
  assert.equal(worker.direct_wrangler_deploy_forbidden, true);
  assert.equal(worker.authorization_consumed_at, "FIRST_WORKER_VERSION_UPLOAD");
  assert.equal(worker.after_upload_mismatch, "STOP_NO_DEPLOY");
  assert.equal(worker.automatic_retry_rollback_cleanup_or_alternate_mutation, false);
  assert.match(String(worker.mutation_ceiling), /ONE_NEW_WORKER_VERSION/);
  assert.match(String(worker.mutation_ceiling), /GET_VERIFIED_VERSION_AT_100_PERCENT/);
  assert.match(String(worker.post_mutation_verification), /^GET_ONLY_/);
});

test("future Worker owner command is public-safe and binds candidate plus exact baseline tuple", () => {
  const command = contract.future_owner_command_templates.WORKER_ACTIVATE;
  for (const field of [
    "source_sha=<sha>",
    "ci_run=<ci_run_id>",
    "preflight_run=<run_id>",
    "deployment=<deployment_id>",
    "version=<version_id>",
    "candidate_sha256=<candidate_manifest_sha256>",
    "key_id=<public_key_id>",
    "ingest=true",
  ]) {
    assert.match(command, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(command, /secret[_ -]?value|private[_ -]?key|token=/i);
});

test("operator doc converges on candidate-only source work and the later #615 executor boundary", () => {
  for (const required of [
    "PHASE5_RPI5_OBSERVATION_WORKER_ACTIVATION_CANDIDATE_V1",
    "src/shared/phase5-worker-activation-candidate.ts",
    "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED",
    "PRESENT_FALSE",
    "candidate_sha256=<candidate_manifest_sha256>",
    "FIRST_WORKER_VERSION_UPLOAD",
    "STOP_NO_DEPLOY",
    "issue #615",
    "direct upload-and-deploy",
    "Queue configuration remain unchanged",
  ]) {
    assert.match(doc, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.match(doc, /performs no upload, version creation, deployment, traffic change/i);
  assert.match(doc, /no automatic retry, rollback, cleanup, version deletion or alternate mutation/i);
});

test("candidate source encodes exact fail-closed delta lists and source config digest", () => {
  for (const required of [
    "source_config_sha256",
    "CREATE_ONE_NEW_WORKER_VERSION_FROM_EXACT_SOURCE_AND_CANDIDATE_CONFIG",
    "ADD_OR_SET_CONTROL_RPI5_OBSERVATION_INGEST_ENABLED_TO_PLAIN_TEXT_TRUE",
    "DEPLOY_ONLY_THE_EXACT_VERIFIED_UPLOADED_VERSION_AT_100_PERCENT",
    "VERIFICATION_KEY_BINDING_OR_VALUE_CHANGE",
    "CONTROL_DB_BINDING_OR_RESOURCE_CHANGE",
    "NON_TARGET_BINDING_CHANGE",
    "ROUTE_OR_CUSTOM_DOMAIN_CHANGE",
    "TRIGGER_OR_QUEUE_CHANGE",
    "FIRST_WORKER_VERSION_UPLOAD",
    "STOP_NO_DEPLOY",
  ]) {
    assert.match(candidate, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("repository production config remains dormant in #614 source-only scope", () => {
  assert.doesNotMatch(wrangler, /CONTROL_RPI5_OBSERVATION_INGEST_ENABLED/);
});
