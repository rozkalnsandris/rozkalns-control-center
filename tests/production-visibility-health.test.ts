import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS,
  type ProductionVisibilityReadModel,
} from "../src/shared/production-visibility.js";
import {
  deriveProductionVisibilityHealth,
  isProductionVisibilityHealthReadModel,
  type ProductionVisibilityHealthProjectIdentity,
} from "../src/shared/production-visibility-health.js";

const PROJECT: ProductionVisibilityHealthProjectIdentity = {
  id: "hermes-tech",
  repository: "rozkalnsandris/hermes-tech",
  productionAdapter: "rpi5",
};

const OBSERVED_AT = "2026-09-11T12:00:00.000Z";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const PRODUCTION_SHA = MAIN_SHA;

function visibility(
  overrides: Partial<ProductionVisibilityReadModel> = {},
): ProductionVisibilityReadModel {
  return {
    projectId: "hermes-tech",
    repository: "rozkalnsandris/hermes-tech",
    mainSha: MAIN_SHA,
    productionSha: PRODUCTION_SHA,
    deployImpact: "NO_DEPLOY",
    runtime: "HEALTHY",
    health: "PASS",
    rollback: "AVAILABLE",
    blockerCodes: [],
    observedAt: OBSERVED_AT,
    productionAdapter: "rpi5",
    drift: "IN_SYNC",
    ...overrides,
  };
}

function now(offsetMs: number): string {
  return new Date(Date.parse(OBSERVED_AT) + offsetMs).toISOString();
}

test("health model reports NOT_OBSERVED without inventing production state", () => {
  const result = deriveProductionVisibilityHealth(PROJECT, null, OBSERVED_AT);
  assert.equal(result.status, "NOT_OBSERVED");
  assert.deepEqual(result.reasonCodes, ["NO_OBSERVATION"]);
  assert.equal(result.evidence, null);
  assert.equal(result.authority.authoritativeForMutation, false);
});

test("fresh in-sync sanitized evidence is HEALTHY through the inclusive freshness boundary", () => {
  const fresh = deriveProductionVisibilityHealth(PROJECT, visibility(), OBSERVED_AT);
  assert.equal(fresh.status, "HEALTHY");
  assert.deepEqual(fresh.reasonCodes, []);
  assert.equal(fresh.evidence?.ageMs, 0);

  const boundary = deriveProductionVisibilityHealth(
    PROJECT,
    visibility(),
    now(MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS),
  );
  assert.equal(boundary.status, "HEALTHY");
  assert.equal(boundary.evidence?.ageMs, MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS);
});

test("evidence older than the freshness ceiling is STALE and non-authoritative", () => {
  const result = deriveProductionVisibilityHealth(
    PROJECT,
    visibility(),
    now(MAX_PRODUCTION_VISIBILITY_EVIDENCE_AGE_MS + 1),
  );
  assert.equal(result.status, "STALE");
  assert.deepEqual(result.reasonCodes, ["STALE_EVIDENCE"]);
  assert.equal(result.authority.authoritativeForMutation, false);
});

test("fresh production SHA divergence is DRIFTED", () => {
  const result = deriveProductionVisibilityHealth(
    PROJECT,
    visibility({
      productionSha: "2222222222222222222222222222222222222222",
      drift: "DRIFTED",
    }),
    OBSERVED_AT,
  );
  assert.equal(result.status, "DRIFTED");
  assert.deepEqual(result.reasonCodes, ["PRODUCTION_SHA_DRIFT"]);
});

test("valid but unhealthy or incomplete evidence is UNKNOWN with bounded reasons", () => {
  const result = deriveProductionVisibilityHealth(
    PROJECT,
    visibility({
      runtime: "DEGRADED",
      health: "UNKNOWN",
      rollback: "UNKNOWN",
      blockerCodes: ["RUNTIME_DEGRADED"],
    }),
    OBSERVED_AT,
  );
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasonCodes, [
    "RUNTIME_NOT_HEALTHY",
    "HEALTH_NOT_PASS",
    "ROLLBACK_NOT_AVAILABLE",
    "BLOCKERS_PRESENT",
  ]);
});

test("future evidence is REJECTED instead of being treated as fresh", () => {
  const result = deriveProductionVisibilityHealth(PROJECT, visibility(), now(-1));
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.reasonCodes, ["FUTURE_EVIDENCE"]);
  assert.equal(result.evidence, null);
});

test("contradictory derived fields are REJECTED", () => {
  const result = deriveProductionVisibilityHealth(
    PROJECT,
    visibility({
      productionSha: "2222222222222222222222222222222222222222",
      drift: "IN_SYNC",
    }),
    OBSERVED_AT,
  );
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.reasonCodes, ["INVALID_EVIDENCE"]);
});

test("project identity mismatch is REJECTED", () => {
  const expected: ProductionVisibilityHealthProjectIdentity = {
    id: "rpi5-main",
    repository: "rozkalnsandris/RPi5_main",
    productionAdapter: "rpi5",
  };
  const result = deriveProductionVisibilityHealth(expected, visibility(), OBSERVED_AT);
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.reasonCodes, ["IDENTITY_MISMATCH"]);
});

test("serialized health receipt is public-safe and never grants mutation authority", () => {
  const result = deriveProductionVisibilityHealth(PROJECT, visibility(), OBSERVED_AT);
  assert.equal(isProductionVisibilityHealthReadModel(result), true);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "signature",
    "privateKey",
    "keyId",
    "deliveryId",
    "replayKey",
    "claimToken",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(result.authority, {
    evidenceOnly: true,
    authoritativeForMutation: false,
    grantsDeployAuthority: false,
    grantsRollbackAuthority: false,
    grantsDatabaseOrHostAuthority: false,
  });
});
