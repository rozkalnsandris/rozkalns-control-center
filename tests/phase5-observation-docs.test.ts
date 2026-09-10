import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const README_PATH = "README.md";
const ROADMAP_PATH = "docs/ROADMAP.md";
const CHECKPOINT_PATH = "docs/ROADMAP_CURRENT_CHECKPOINT.md";
const OPERATOR_PATH = "docs/PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const durableDocs = [README_PATH, ROADMAP_PATH, CHECKPOINT_PATH, OPERATOR_PATH];

const staleActiveLanePatterns = [
  /Current safe Control lane is issue \*\*#574\*\*/,
  /current Control work item[^\n]*#574/i,
  /Issue #576 is the current focused/i,
  /current Control work item[^\n]*#576/i,
  /Complete issue #576 through focused/i,
  /next Phase 5 problem is a separately reviewed read-only observation\/transport boundary/i,
];

test("durable Phase 5 docs do not regress to completed #574/#576 current lanes", () => {
  for (const path of durableDocs) {
    const text = source(path);
    for (const pattern of staleActiveLanePatterns) {
      assert.doesNotMatch(text, pattern, `${path} contains stale current-lane wording: ${pattern}`);
    }
  }
});

test("README and roadmap navigation converge on the Phase 5 operator contract", () => {
  const operatorLink = "PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md";

  for (const path of [README_PATH, ROADMAP_PATH, CHECKPOINT_PATH]) {
    assert.match(source(path), new RegExp(operatorLink.replaceAll(".", "\\.")), `${path} must link the operator contract`);
  }

  assert.match(source(README_PATH), /post-#596/i);
  assert.match(source(ROADMAP_PATH), /PR #596/);
  assert.match(source(CHECKPOINT_PATH), /PR #612/);
});

test("durable docs retain source-vs-live and merge-vs-deploy boundary markers", () => {
  const requiredMarkers = [
    "SOURCE_READY_LIVE_UNPROVEN",
    "READONLY_PREFLIGHT_EVIDENCE_ONLY",
    "MERGE_NOT_DEPLOY_AUTHORITY",
  ];

  for (const path of durableDocs) {
    const text = source(path);
    for (const marker of requiredMarkers) {
      assert.match(text, new RegExp(marker), `${path} is missing ${marker}`);
    }
  }
});

test("operator contract records the merged authenticated observation chain", () => {
  const text = source(OPERATOR_PATH);

  for (const required of [
    "Ed25519-authenticated outer delivery",
    "verification-key registry",
    "durable replay claim",
    "strict ten-field production-visibility normalization",
    "transactional replay + monotonic projection acceptance",
    "dormant Worker route/runtime",
    "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED",
    "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS",
    "0011_rpi5_observation_replay_claims.sql",
    "0012_rpi5_production_visibility_projection.sql",
    "0013_rpi5_observation_atomic_acceptance.sql",
  ]) {
    assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("operator preflight contract is evidence-only and zero-mutation classified", () => {
  const text = source(OPERATOR_PATH);

  for (const required of [
    "exact-main `CI` push run",
    "GET-only APIs",
    "CONTROL_DB",
    "one statement beginning with `SELECT `",
    "changed_db=false",
    "rows_written=0",
    "changes=0",
    "INGEST_ALREADY_ACTIVE",
    "PRESENT_PROTECTED",
    "ABSENT_CONSISTENT",
    "PRESENT_VALID",
    "BASELINE=SAFE_FOR_SEPARATELY_AUTHORIZED_ACTIVATION_PLANNING",
  ]) {
    assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(text, /A FAIL must never be .*unapproved production mutation/i);
  assert.match(text, /A PASS must never be interpreted as permission to mutate production/i);
});

test("future activation order keeps every mutation-bearing step separately gated", () => {
  const text = source(OPERATOR_PATH);

  assert.match(text, /Fresh production baseline/);
  assert.match(text, /D1 migration apply, if required/);
  assert.match(text, /Verification-key provisioning, if required/);
  assert.match(text, /Worker configuration\/deployment\/activation/);
  assert.match(text, /RPi5 signer\/private-key\/runtime delivery/);
  assert.match(text, /Observation reconciliation/);
  assert.match(text, /Every mutation-bearing step requires its own exact owner\/LIVE authority/);
});

test("Phase 5 trust-boundary checklist preserves forbidden shortcuts and non-authority", () => {
  const text = source(OPERATOR_PATH);

  for (const required of [
    "No direct Control SSH, sudo, root",
    "No Control-side protected-host filesystem",
    "No verification-key/private-key value",
    "source-controlled migration is never represented as proof of remote migration application",
    "source merge is never represented as proof of Worker deployment",
    "Observation evidence is never treated as deploy, rollback, DB/data, Queue, credential or host authority",
    "Historical Phase 3/4 canaries and consumed authorization receipts are never replayed",
  ]) {
    assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
