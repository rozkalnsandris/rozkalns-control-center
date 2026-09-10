import assert from "node:assert/strict";
import test from "node:test";
import {
  PHASE5_WORKER_ACTIVATION_ALLOWED_DELTAS,
  PHASE5_WORKER_ACTIVATION_FORBIDDEN_DELTAS,
  Phase5WorkerActivationCandidateError,
  assertPhase5WorkerActivationCandidateMatchesObservedBaseline,
  normalizePhase5WorkerActivationCandidateManifest,
  type Phase5WorkerActivationCandidateManifest,
  type Phase5WorkerActivationObservedBaseline,
} from "../src/shared/phase5-worker-activation-candidate.js";
import {
  VALID_PHASE5_WORKER_ACTIVATION_CANDIDATE,
  VALID_PHASE5_WORKER_ACTIVATION_OBSERVED_BASELINE,
} from "./phase5-worker-activation-candidate.fixtures.js";

type MutableRecord = Record<string, unknown>;

function mutableRecord<T>(value: T): MutableRecord {
  return structuredClone(value) as unknown as MutableRecord;
}

function setPath(root: MutableRecord, path: readonly string[], value: unknown): void {
  assert.ok(path.length > 0);
  let current = root;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    assert.ok(next && typeof next === "object" && !Array.isArray(next));
    current = next as MutableRecord;
  }
  current[path[path.length - 1]!] = value;
}

function assertCandidateRejected(path: readonly string[], value: unknown): void {
  const candidate = mutableRecord(VALID_PHASE5_WORKER_ACTIVATION_CANDIDATE);
  setPath(candidate, path, value);
  assert.throws(
    () => normalizePhase5WorkerActivationCandidateManifest(candidate),
    Phase5WorkerActivationCandidateError,
  );
}

function assertBaselineRejected(path: readonly string[], value: unknown): void {
  const manifest = normalizePhase5WorkerActivationCandidateManifest(
    VALID_PHASE5_WORKER_ACTIVATION_CANDIDATE,
  );
  const baseline = mutableRecord(VALID_PHASE5_WORKER_ACTIVATION_OBSERVED_BASELINE);
  setPath(baseline, path, value);
  assert.throws(
    () =>
      assertPhase5WorkerActivationCandidateMatchesObservedBaseline(
        manifest,
        baseline as unknown as Phase5WorkerActivationObservedBaseline,
      ),
    Phase5WorkerActivationCandidateError,
  );
}

test("valid Phase 5 Worker activation candidate normalizes and matches the exact observed baseline", () => {
  const normalized = normalizePhase5WorkerActivationCandidateManifest(
    VALID_PHASE5_WORKER_ACTIVATION_CANDIDATE,
  );

  assert.deepEqual(normalized, VALID_PHASE5_WORKER_ACTIVATION_CANDIDATE);
  assert.doesNotThrow(() =>
    assertPhase5WorkerActivationCandidateMatchesObservedBaseline(
      normalized,
      VALID_PHASE5_WORKER_ACTIVATION_OBSERVED_BASELINE,
    ),
  );
});

test("candidate schema is exact and binds source, CI, preflight, baseline version, and source config digest", () => {
  assertCandidateRejected(["extra"], true);
  assertCandidateRejected(["source_sha"], "not-a-sha");
  assertCandidateRejected(["ci_run_id"], "0");
  assertCandidateRejected(["preflight_run_id"], "01");
  assertCandidateRejected(["source_config_sha256"], "d".repeat(63));
  assertCandidateRejected(["expected_current", "deployment_id"], "not-a-uuid");
  assertCandidateRejected(["expected_current", "version_id"], "not-a-uuid");
  assertCandidateRejected(["expected_current", "traffic_percent"], 99);
});

test("candidate accepts only a dormant ingest baseline and exact plain-text true activation", () => {
  const presentFalse = mutableRecord(VALID_PHASE5_WORKER_ACTIVATION_CANDIDATE);
  setPath(presentFalse, ["expected_current", "ingest_binding_state"], "PRESENT_FALSE");
  assert.doesNotThrow(() => normalizePhase5WorkerActivationCandidateManifest(presentFalse));

  assertCandidateRejected(["expected_current", "ingest_binding_state"], "PRESENT_TRUE");
  assertCandidateRejected(["intended_result", "ingest_binding", "value"], "false");
  assertCandidateRejected(["intended_result", "ingest_binding", "type"], "secret_text");
  assertCandidateRejected(["intended_result", "ingest_binding", "name"], "OTHER_BINDING");
});

test("verification-key prerequisite must remain protected, exact-key, and value-unobserved", () => {
  assertCandidateRejected(
    ["expected_current", "verification_key_prerequisite", "type"],
    "plain_text",
  );
  assertCandidateRejected(
    ["expected_current", "verification_key_prerequisite", "state"],
    "ABSENT",
  );
  assertCandidateRejected(
    ["expected_current", "verification_key_prerequisite", "value_observed"],
    true,
  );
  assertCandidateRejected(
    ["intended_result", "verification_key_binding", "key_id"],
    "different-key",
  );
  assertCandidateRejected(
    ["intended_result", "verification_key_binding", "state"],
    "CHANGED",
  );
});

test("D1 prerequisite and non-target bindings must remain exact and unchanged", () => {
  assertCandidateRejected(
    ["expected_current", "d1_prerequisite", "database_id"],
    "33333333-3333-4333-8333-333333333333",
  );
  assertCandidateRejected(["expected_current", "d1_prerequisite", "migration_state"], "PARTIAL");
  assertCandidateRejected(["intended_result", "d1_binding", "state"], "CHANGED");
  assertCandidateRejected(["intended_result", "non_target_bindings_sha256"], "d".repeat(64));
});

test("routes, custom domains, triggers, queues and unrelated config are fail-closed", () => {
  assertCandidateRejected(["intended_result", "routes"], "CHANGED");
  assertCandidateRejected(["intended_result", "custom_domains"], "CHANGED");
  assertCandidateRejected(["intended_result", "triggers"], "CHANGED");

  assert.deepEqual(
    VALID_PHASE5_WORKER_ACTIVATION_CANDIDATE.forbidden_deltas,
    PHASE5_WORKER_ACTIVATION_FORBIDDEN_DELTAS,
  );
  assert.ok(PHASE5_WORKER_ACTIVATION_FORBIDDEN_DELTAS.includes("TRIGGER_OR_QUEUE_CHANGE"));
  assert.ok(PHASE5_WORKER_ACTIVATION_FORBIDDEN_DELTAS.includes("NON_TARGET_BINDING_CHANGE"));

  assertCandidateRejected(
    ["forbidden_deltas"],
    PHASE5_WORKER_ACTIVATION_FORBIDDEN_DELTAS.filter(
      (delta) => delta !== "TRIGGER_OR_QUEUE_CHANGE",
    ),
  );
});

test("allowed mutation plan is exact upload-verify-deploy and cannot become direct deploy", () => {
  assert.deepEqual(
    VALID_PHASE5_WORKER_ACTIVATION_CANDIDATE.allowed_deltas,
    PHASE5_WORKER_ACTIVATION_ALLOWED_DELTAS,
  );
  assert.deepEqual(PHASE5_WORKER_ACTIVATION_ALLOWED_DELTAS, [
    "CREATE_ONE_NEW_WORKER_VERSION_FROM_EXACT_SOURCE_AND_CANDIDATE_CONFIG",
    "ADD_OR_SET_CONTROL_RPI5_OBSERVATION_INGEST_ENABLED_TO_PLAIN_TEXT_TRUE",
    "DEPLOY_ONLY_THE_EXACT_VERIFIED_UPLOADED_VERSION_AT_100_PERCENT",
  ]);

  assertCandidateRejected(["intended_result", "version_strategy"], "DIRECT_DEPLOY");
  assertCandidateRejected(["allowed_deltas"], ["DIRECT_DEPLOY"]);
});

test("one-shot semantics consume authorization at first upload and forbid automatic recovery or cascade", () => {
  assertCandidateRejected(["one_shot", "authorization_consumed_at"], "DEPLOY");
  assertCandidateRejected(["one_shot", "cross_class_cascade"], true);
  assertCandidateRejected(
    ["one_shot", "automatic_retry_rollback_cleanup_or_alternate_mutation"],
    true,
  );
  assertCandidateRejected(["one_shot", "after_upload_mismatch"], "RETRY_UPLOAD");
  assertCandidateRejected(["one_shot", "post_deploy_verification"], "WRITE_PROBE");
});

test("observed baseline drift invalidates an otherwise valid candidate", () => {
  assertBaselineRejected(["source_sha"], "d".repeat(40));
  assertBaselineRejected(["version_id"], "33333333-3333-4333-8333-333333333333");
  assertBaselineRejected(["ingest_binding_state"], "PRESENT_FALSE");
  assertBaselineRejected(["verification_key_id"], "different-key");
  assertBaselineRejected(["verification_key_value_observed"], true);
  assertBaselineRejected(["d1_database_id"], "33333333-3333-4333-8333-333333333333");
  assertBaselineRejected(["non_target_bindings_sha256"], "d".repeat(64));
});

test("normalized candidate remains assignable to the public manifest contract", () => {
  const manifest: Phase5WorkerActivationCandidateManifest =
    normalizePhase5WorkerActivationCandidateManifest(VALID_PHASE5_WORKER_ACTIVATION_CANDIDATE);
  assert.equal(manifest.one_shot.after_upload_mismatch, "STOP_NO_DEPLOY");
});
