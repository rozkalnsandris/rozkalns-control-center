import assert from "node:assert/strict";
import test from "node:test";
import {
  PHASE5_RPI5_SIGNER_HANDOFF_MAX_AGE_MS,
  Phase5Rpi5SignerHandoffError,
  assertPhase5Rpi5SignerHandoffMatchesExpectedIdentity,
  normalizePhase5Rpi5SignerHandoffManifest,
  type Phase5Rpi5SignerHandoffExpectedIdentity,
} from "../src/shared/phase5-rpi5-signer-handoff.js";
import {
  PHASE5_RPI5_SIGNER_HANDOFF_FIXTURE_NOW,
  VALID_PHASE5_RPI5_SIGNER_HANDOFF,
  VALID_PHASE5_RPI5_SIGNER_HANDOFF_EXPECTED_IDENTITY,
} from "./phase5-rpi5-signer-handoff.fixtures.js";

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

function assertManifestRejected(path: readonly string[], value: unknown): void {
  const manifest = mutableRecord(VALID_PHASE5_RPI5_SIGNER_HANDOFF);
  setPath(manifest, path, value);
  assert.throws(
    () => normalizePhase5Rpi5SignerHandoffManifest(manifest, PHASE5_RPI5_SIGNER_HANDOFF_FIXTURE_NOW),
    Phase5Rpi5SignerHandoffError,
  );
}

function assertIdentityRejected(
  path: keyof Phase5Rpi5SignerHandoffExpectedIdentity,
  value: string,
): void {
  const manifest = normalizePhase5Rpi5SignerHandoffManifest(
    VALID_PHASE5_RPI5_SIGNER_HANDOFF,
    PHASE5_RPI5_SIGNER_HANDOFF_FIXTURE_NOW,
  );
  const expected = {
    ...VALID_PHASE5_RPI5_SIGNER_HANDOFF_EXPECTED_IDENTITY,
    [path]: value,
  } as Phase5Rpi5SignerHandoffExpectedIdentity;

  assert.throws(
    () => assertPhase5Rpi5SignerHandoffMatchesExpectedIdentity(manifest, expected),
    Phase5Rpi5SignerHandoffError,
  );
}

test("valid Phase 5 RPi5 signer handoff normalizes and matches exact expected identity", () => {
  const normalized = normalizePhase5Rpi5SignerHandoffManifest(
    VALID_PHASE5_RPI5_SIGNER_HANDOFF,
    PHASE5_RPI5_SIGNER_HANDOFF_FIXTURE_NOW,
  );

  assert.deepEqual(normalized, VALID_PHASE5_RPI5_SIGNER_HANDOFF);
  assert.doesNotThrow(() =>
    assertPhase5Rpi5SignerHandoffMatchesExpectedIdentity(
      normalized,
      VALID_PHASE5_RPI5_SIGNER_HANDOFF_EXPECTED_IDENTITY,
    ),
  );
});

test("handoff schema is exact at every nesting boundary", () => {
  assertManifestRejected(["extra"], "not-admitted");
  assertManifestRejected(["expected_worker", "extra"], "not-admitted");
  assertManifestRejected(["receiver", "extra"], "not-admitted");
  assertManifestRejected(["authority", "extra"], "not-admitted");
});

test("handoff binds exact Control source and Worker deployment/version identity", () => {
  assertManifestRejected(["control_source_sha"], "not-a-sha");
  assertManifestRejected(["expected_worker", "deployment_id"], "not-a-uuid");
  assertManifestRejected(["expected_worker", "version_id"], "not-a-uuid");
  assertManifestRejected(["expected_worker", "traffic_percent"], 99);
  assertManifestRejected(["expected_worker", "ingest_state"], "PRESENT_FALSE");
});

test("handoff accepts only the fixed observation protocol and public key identifier shape", () => {
  assertManifestRejected(["observation_contract_version"], "control-phase5-rpi5-observation-v2");
  assertManifestRejected(["key_id"], "bad key id");
  assertManifestRejected(["key_id"], "x".repeat(65));
});

test("handoff freshness accepts the bounded window and rejects stale, future, or non-canonical time", () => {
  const generatedAtMs = Date.parse(VALID_PHASE5_RPI5_SIGNER_HANDOFF.generated_at);
  assert.doesNotThrow(() =>
    normalizePhase5Rpi5SignerHandoffManifest(
      VALID_PHASE5_RPI5_SIGNER_HANDOFF,
      new Date(generatedAtMs + PHASE5_RPI5_SIGNER_HANDOFF_MAX_AGE_MS).toISOString(),
    ),
  );

  assert.throws(
    () =>
      normalizePhase5Rpi5SignerHandoffManifest(
        VALID_PHASE5_RPI5_SIGNER_HANDOFF,
        new Date(generatedAtMs + PHASE5_RPI5_SIGNER_HANDOFF_MAX_AGE_MS + 1).toISOString(),
      ),
    Phase5Rpi5SignerHandoffError,
  );
  assert.throws(
    () =>
      normalizePhase5Rpi5SignerHandoffManifest(
        VALID_PHASE5_RPI5_SIGNER_HANDOFF,
        new Date(generatedAtMs - 1).toISOString(),
      ),
    Phase5Rpi5SignerHandoffError,
  );
  assertManifestRejected(["generated_at"], "2026-09-10T17:00:00Z");
});

test("receiver and no-authority semantics are immutable literals", () => {
  assertManifestRejected(["receiver", "repository"], "other/repository");
  assertManifestRejected(["receiver", "lane"], "OTHER_LANE");
  assertManifestRejected(["receiver", "authority_owner"], "Control");
  assertManifestRejected(["authority", "evidence_only"], false);
  assertManifestRejected(["authority", "grants_live_authority"], true);
  assertManifestRejected(["authority", "grants_cross_repo_write"], true);
  assertManifestRejected(["authority", "grants_rpi5_runtime_mutation"], true);
});

test("expected identity drift rejects an otherwise valid handoff", () => {
  assertIdentityRejected("control_source_sha", "b".repeat(40));
  assertIdentityRejected("deployment_id", "33333333-3333-4333-8333-333333333333");
  assertIdentityRejected("version_id", "44444444-4444-4444-8444-444444444444");
  assertIdentityRejected("key_id", "different-public-key-id");
});

test("fail-closed errors never echo rejected manifest values", () => {
  const rejected = mutableRecord(VALID_PHASE5_RPI5_SIGNER_HANDOFF);
  const marker = "synthetic-rejected-value";
  setPath(rejected, ["key_id"], marker);

  assert.throws(
    () => normalizePhase5Rpi5SignerHandoffManifest(rejected, PHASE5_RPI5_SIGNER_HANDOFF_FIXTURE_NOW),
    (error: unknown) => {
      assert.ok(error instanceof Phase5Rpi5SignerHandoffError);
      assert.equal(error.message.includes(marker), false);
      return true;
    },
  );
});
