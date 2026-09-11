import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PHASE5_READONLY_CHECKPOINTS,
  PHASE5_REMAINING_OWNER_GATES,
  PHASE5_SOURCE_COMPLETED_SLICES,
  PHASE5_SOURCE_COMPLETION_CONTRACT,
  PHASE5_SOURCE_COMPLETION_INVARIANTS,
  getPhase5SourceCompletionReconciliation,
} from "../src/shared/phase5-source-completion.js";

const ROADMAP_PATH = "docs/ROADMAP.md";
const CHECKPOINT_PATH = "docs/ROADMAP_CURRENT_CHECKPOINT.md";
const RECONCILIATION_PATH = "docs/PHASE5_SOURCE_COMPLETION_RECONCILIATION.md";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("Phase 5 reconciliation marks the queued source chain complete without proving LIVE state", () => {
  const reconciliation = getPhase5SourceCompletionReconciliation();

  assert.equal(reconciliation.contract, PHASE5_SOURCE_COMPLETION_CONTRACT);
  assert.equal(reconciliation.status, "SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN");
  assert.equal(reconciliation.sourceComplete, true);
  assert.equal(reconciliation.liveStateProven, false);
  assert.equal(reconciliation.nextSourceLane, null);
  assert.equal(reconciliation.stopAtFirstGenuineLiveOrExternalGate, true);
  assert.deepEqual(reconciliation.completedSlices, PHASE5_SOURCE_COMPLETED_SLICES);
});

test("remaining owner gates preserve conditional D1/key work and the external RPi5 boundary", () => {
  assert.deepEqual(PHASE5_REMAINING_OWNER_GATES, [
    "CREDENTIAL_ENVIRONMENT_PREREQUISITES_IF_MISSING",
    "D1_APPLY_IF_FRESH_PREFLIGHT_REQUIRES",
    "VERIFICATION_KEY_PROVISION_IF_FRESH_PREFLIGHT_REQUIRES",
    "WORKER_ACTIVATE_AFTER_PREREQUISITES",
    "RPI5_SIGNER_RUNTIME_AFTER_WORKER_VERIFY",
  ]);

  const reconciliation = getPhase5SourceCompletionReconciliation();
  assert.equal(
    reconciliation.firstLiveGateSelection,
    "REQUIRES_FRESH_READONLY_BASELINE_AND_ENVIRONMENT_EVIDENCE",
  );
});

test("read-only checkpoints stay technical evidence steps and do not collapse owner gates", () => {
  assert.deepEqual(PHASE5_READONLY_CHECKPOINTS, [
    "FRESH_EXACT_MAIN_PRODUCTION_PREFLIGHT_BEFORE_FIRST_LIVE_MUTATION",
    "READONLY_REVERIFY_AFTER_D1_APPLY_IF_RUN",
    "GET_ONLY_VERIFY_AFTER_VERIFICATION_KEY_PROVISION_IF_RUN",
    "GET_ONLY_VERIFY_UPLOADED_WORKER_VERSION_BEFORE_DEPLOY",
    "GET_ONLY_POST_ACTIVATION_WORKER_VERIFY",
    "READONLY_SIGNED_OBSERVATION_RECONCILIATION_AFTER_RPI5_RUNTIME",
  ]);

  assert.equal(
    getPhase5SourceCompletionReconciliation().invariants.readonlyPreflightGrantsMutationAuthority,
    false,
  );
});

test("authority invariants forbid merge inheritance, cross-class cascade, replay and protected-data leakage", () => {
  assert.deepEqual(PHASE5_SOURCE_COMPLETION_INVARIANTS, {
    sourceMergeGrantsLiveAuthority: false,
    readonlyPreflightGrantsMutationAuthority: false,
    crossClassCascade: false,
    historicalAuthorizationReplay: false,
    protectedValueInPublicEvidence: false,
    automaticRetryRollbackCleanupOrAlternateMutation: false,
    controlOwnsRpi5SignerRuntime: false,
    observationEvidenceGrantsMutationAuthority: false,
  });
});

test("durable Phase 5 docs converge on source completion instead of stale #614/#615 source lanes", () => {
  for (const path of [ROADMAP_PATH, CHECKPOINT_PATH, RECONCILIATION_PATH]) {
    const text = source(path);
    assert.match(text, /SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN/);
    assert.match(text, /MERGE_NOT_DEPLOY_AUTHORITY/);
    assert.doesNotMatch(text, /next (?:queued )?Control lane is #614/i);
    assert.doesNotMatch(text, /WORKER_ACTIVATE[^\n]*next incomplete Control source mutation class/i);
    assert.doesNotMatch(text, /executor implementation remains #615 source work/i);
  }
});

test("completion operator doc names the merged source slices and stops before LIVE authority", () => {
  const text = source(RECONCILIATION_PATH);

  for (const required of [
    "phase5-rpi5-observation-d1-live.yml",
    "phase5-rpi5-observation-verification-key-live.yml",
    "phase5-rpi5-observation-worker-activate-live.yml",
    "phase5-rpi5-observation-worker-post-activation-verify.yml",
    "PHASE5_RPI5_SIGNER_HANDOFF_V1",
    "control-phase5-rpi5-observation-reconciliation-v1",
    "control-phase5-production-visibility-health-v1",
    "control-phase5-production-visibility-notification-v1",
  ]) {
    assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(text, /fresh exact-main GET\/SELECT-only preflight/i);
  assert.match(text, /D1 apply only if the fresh preflight requires it/i);
  assert.match(text, /separate owner\/LIVE authorization/i);
  assert.match(text, /RPi5_main/);
  assert.match(text, /no new source lane/i);
});
