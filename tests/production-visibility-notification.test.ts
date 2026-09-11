import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProductionVisibilityHealthEvidence,
  ProductionVisibilityHealthReadModel,
  ProductionVisibilityHealthReasonCode,
  ProductionVisibilityHealthStatus,
} from "../src/shared/production-visibility-health.js";
import {
  evaluateProductionVisibilityNotificationTransition,
  productionVisibilityNotificationCandidate,
  productionVisibilityNotificationTransitionId,
} from "../src/shared/production-visibility-notification.js";

const MAIN_SHA = "1111111111111111111111111111111111111111";
const PROD_SHA = "2222222222222222222222222222222222222222";
const OBSERVED_AT = "2026-09-11T12:00:00.000Z";

function evidence(
  overrides: Partial<ProductionVisibilityHealthEvidence> = {},
): ProductionVisibilityHealthEvidence {
  return {
    projectId: "hermes-tech",
    repository: "rozkalnsandris/hermes-tech",
    mainSha: MAIN_SHA,
    productionSha: PROD_SHA,
    deployImpact: "NO_DEPLOY",
    runtime: "HEALTHY",
    health: "PASS",
    rollback: "AVAILABLE",
    blockerCodes: [],
    observedAt: OBSERVED_AT,
    drift: "DRIFTED",
    ageMs: 42_000,
    ...overrides,
  };
}

function health(
  status: ProductionVisibilityHealthStatus,
  overrides: Partial<ProductionVisibilityHealthReadModel> = {},
): ProductionVisibilityHealthReadModel {
  const defaultReasons: Partial<
    Record<ProductionVisibilityHealthStatus, readonly ProductionVisibilityHealthReasonCode[]>
  > = {
    STALE: ["STALE_EVIDENCE"],
    DRIFTED: ["PRODUCTION_SHA_DRIFT"],
    REJECTED: ["INVALID_EVIDENCE"],
    NOT_OBSERVED: ["NO_OBSERVATION"],
  };
  return {
    contractId: "control-phase5-production-visibility-health-v1",
    projectId: "hermes-tech",
    repository: "rozkalnsandris/hermes-tech",
    status,
    reasonCodes: defaultReasons[status] ?? [],
    evidence:
      status === "REJECTED" || status === "NOT_OBSERVED"
        ? null
        : evidence({ drift: status === "DRIFTED" ? "DRIFTED" : "IN_SYNC" }),
    authority: {
      evidenceOnly: true,
      authoritativeForMutation: false,
      grantsDeployAuthority: false,
      grantsRollbackAuthority: false,
      grantsDatabaseOrHostAuthority: false,
    },
    ...overrides,
  };
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

test("STALE, DRIFTED and REJECTED entries emit high-signal provider-neutral candidates", () => {
  for (const status of ["STALE", "DRIFTED", "REJECTED"] as const) {
    const result = evaluateProductionVisibilityNotificationTransition(
      health("HEALTHY"),
      health(status),
    );
    assert.equal(result.kind, "NEW_TRANSITION");
    if (result.kind !== "NEW_TRANSITION") continue;
    assert.equal(result.candidate.signal, status);
    assert.equal(result.candidate.status, status);
    assert.equal(result.candidate.previousStatus, "HEALTHY");
    assert.equal(result.candidate.deepLinkPath, "/#projects-title");
  }
});

test("unchanged alert state is deduplicated even as freshness diagnostics advance", () => {
  const previous = health("STALE", {
    evidence: evidence({ drift: "IN_SYNC", ageMs: 301_000 }),
  });
  const current = health("STALE", {
    evidence: evidence({ drift: "IN_SYNC", ageMs: 420_000 }),
  });

  assert.deepEqual(evaluateProductionVisibilityNotificationTransition(previous, current), {
    kind: "NO_SIGNAL",
    reason: "UNCHANGED",
  });
  assert.equal(
    productionVisibilityNotificationTransitionId(previous, previous, "STALE"),
    productionVisibilityNotificationTransitionId(previous, current, "STALE"),
  );
});

test("a material alert-status transition emits a new transition without reminder polling", () => {
  const previous = health("STALE", {
    evidence: evidence({ drift: "IN_SYNC", ageMs: 301_000 }),
  });
  const current = health("DRIFTED", {
    evidence: evidence({ drift: "DRIFTED", ageMs: 10_000 }),
  });
  const result = evaluateProductionVisibilityNotificationTransition(previous, current);

  assert.equal(result.kind, "NEW_TRANSITION");
  if (result.kind !== "NEW_TRANSITION") return;
  assert.equal(result.candidate.signal, "DRIFTED");
  assert.notEqual(
    result.candidate.transitionId,
    productionVisibilityNotificationTransitionId(null, current, "DRIFTED"),
  );
});

test("HEALTHY emits recovery only after an alert state", () => {
  for (const previousStatus of ["STALE", "DRIFTED", "REJECTED"] as const) {
    const result = evaluateProductionVisibilityNotificationTransition(
      health(previousStatus),
      health("HEALTHY", {
        evidence: evidence({ productionSha: MAIN_SHA, drift: "IN_SYNC", ageMs: 2_000 }),
      }),
    );
    assert.equal(result.kind, "NEW_TRANSITION");
    if (result.kind !== "NEW_TRANSITION") continue;
    assert.equal(result.candidate.signal, "RECOVERED");
    assert.equal(result.candidate.previousStatus, previousStatus);
    assert.equal(result.candidate.status, "HEALTHY");
  }

  for (const previousStatus of ["HEALTHY", "UNKNOWN", "NOT_OBSERVED"] as const) {
    assert.deepEqual(
      evaluateProductionVisibilityNotificationTransition(
        health(previousStatus),
        health("HEALTHY", {
          evidence: evidence({ productionSha: MAIN_SHA, drift: "IN_SYNC" }),
        }),
      ),
      { kind: "NO_SIGNAL", reason: "LOW_SIGNAL" },
    );
  }
});

test("missing, unknown and not-observed current evidence never become healthy-by-default", () => {
  assert.deepEqual(
    evaluateProductionVisibilityNotificationTransition(health("DRIFTED"), null),
    {
      kind: "NO_SIGNAL",
      reason: "MISSING_CURRENT_EVIDENCE",
    },
  );
  assert.deepEqual(
    evaluateProductionVisibilityNotificationTransition(health("DRIFTED"), health("UNKNOWN")),
    {
      kind: "NO_SIGNAL",
      reason: "LOW_SIGNAL",
    },
  );
  assert.deepEqual(
    evaluateProductionVisibilityNotificationTransition(
      health("DRIFTED"),
      health("NOT_OBSERVED"),
    ),
    {
      kind: "NO_SIGNAL",
      reason: "LOW_SIGNAL",
    },
  );
});

test("cross-project continuity fails closed instead of manufacturing a recovery or alert", () => {
  const previous = health("DRIFTED");
  const current = health("HEALTHY", {
    projectId: "rpi5-main",
    repository: "rozkalnsandris/RPi5_main",
    evidence: evidence({
      projectId: "rpi5-main",
      repository: "rozkalnsandris/RPi5_main",
      productionSha: MAIN_SHA,
      drift: "IN_SYNC",
    }),
  });

  assert.deepEqual(evaluateProductionVisibilityNotificationTransition(previous, current), {
    kind: "NO_SIGNAL",
    reason: "IDENTITY_MISMATCH",
  });
});

test("candidate is bounded, sanitized and excludes provider or remediation authority", () => {
  const current = health("DRIFTED", {
    projectId: `hermes-tech\u0000${"x".repeat(200)}`,
    repository: `rozkalnsandris/hermes-tech\n${"y".repeat(240)}`,
    reasonCodes: ["PRODUCTION_SHA_DRIFT"],
    evidence: evidence({
      mainSha: "not-a-sha",
      productionSha: PROD_SHA,
      observedAt: "not-a-time",
      ageMs: -1,
    }),
  });
  const candidate = productionVisibilityNotificationCandidate(
    health("HEALTHY"),
    current,
    "DRIFTED",
  );
  const serialized = JSON.stringify(candidate);

  assert.ok(Array.from(candidate.projectId).length <= 128);
  assert.ok(Array.from(candidate.repository).length <= 201);
  assert.ok(Array.from(candidate.title).length <= 160);
  assert.ok(Array.from(candidate.body).length <= 280);
  assert.equal(hasControlCharacter(candidate.projectId), false);
  assert.equal(hasControlCharacter(candidate.repository), false);
  assert.equal(hasControlCharacter(candidate.title), false);
  assert.equal(hasControlCharacter(candidate.body), false);
  assert.equal(candidate.diagnostics.mainSha, null);
  assert.equal(candidate.diagnostics.productionSha, PROD_SHA);
  assert.equal(candidate.diagnostics.observedAt, null);
  assert.equal(candidate.diagnostics.ageSeconds, null);
  assert.match(candidate.transitionId, /^production-visibility-v1-drifted-[0-9a-f]{16}$/);
  for (const forbidden of [
    "deployImpact",
    "runtime",
    "rollback",
    "blockerCodes",
    "signature",
    "privateKey",
    "keyId",
    "deliveryId",
    "replayKey",
    "claimToken",
    "providerToken",
    "telegram",
    "remediation",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("a later alert re-entry with new observation identity produces a fresh dedupe key", () => {
  const healthy = health("HEALTHY", {
    evidence: evidence({ productionSha: MAIN_SHA, drift: "IN_SYNC" }),
  });
  const firstDrift = health("DRIFTED");
  const laterDrift = health("DRIFTED", {
    evidence: evidence({
      observedAt: "2026-09-11T12:05:00.000Z",
      ageMs: 5_000,
      drift: "DRIFTED",
    }),
  });
  const first = evaluateProductionVisibilityNotificationTransition(healthy, firstDrift);
  const recovered = evaluateProductionVisibilityNotificationTransition(firstDrift, healthy);
  const second = evaluateProductionVisibilityNotificationTransition(healthy, laterDrift);

  assert.equal(first.kind, "NEW_TRANSITION");
  assert.equal(recovered.kind, "NEW_TRANSITION");
  assert.equal(second.kind, "NEW_TRANSITION");
  if (first.kind === "NEW_TRANSITION" && second.kind === "NEW_TRANSITION") {
    assert.notEqual(first.candidate.transitionId, second.candidate.transitionId);
  }
});
