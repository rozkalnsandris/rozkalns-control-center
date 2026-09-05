import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  normalizeProductionVisibility,
  normalizeSanitizedProductionVisibility,
  ProductionVisibilityError,
  SANITIZED_PRODUCTION_VISIBILITY_FIELDS,
  type ProductionVisibilityEvidence,
} from "../src/shared/production-visibility.js";

const OBSERVED_AT = "2026-09-01T08:00:00.000Z";
const NOW = "2026-09-01T08:04:00.000Z";
const MAIN = "1111111111111111111111111111111111111111";
const PRODUCTION = "2222222222222222222222222222222222222222";

function evidence(overrides: Partial<ProductionVisibilityEvidence> = {}): ProductionVisibilityEvidence {
  return {
    projectId: "hermes-tech",
    repository: "rozkalnsandris/hermes-tech",
    mainSha: MAIN,
    productionSha: PRODUCTION,
    deployImpact: "MANUAL_ROLLOUT_REQUIRED",
    runtime: "HEALTHY",
    health: "PASS",
    rollback: "AVAILABLE",
    blockerCodes: ["PRODUCTION_SHA_BEHIND_MAIN"],
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function expectError(code: string, action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof ProductionVisibilityError && error.code === code,
  );
}

test("normalizes bounded sanitized RPi5 production evidence and derives drift", () => {
  const result = normalizeProductionVisibility(evidence(), NOW);

  assert.deepEqual(result, {
    ...evidence(),
    productionAdapter: "rpi5",
    drift: "DRIFTED",
  });
});

test("strict sanitized ingestion accepts only the reviewed production evidence shape", () => {
  const input: unknown = JSON.parse(JSON.stringify(evidence()));
  const result = normalizeSanitizedProductionVisibility(input, NOW);

  assert.equal(result.projectId, "hermes-tech");
  assert.equal(result.productionAdapter, "rpi5");
  assert.equal(result.drift, "DRIFTED");
  assert.deepEqual(SANITIZED_PRODUCTION_VISIBILITY_FIELDS, [
    "projectId",
    "repository",
    "mainSha",
    "productionSha",
    "deployImpact",
    "runtime",
    "health",
    "rollback",
    "blockerCodes",
    "observedAt",
  ]);
});

test("strict sanitized ingestion rejects extra host, log and secret-like fields", () => {
  for (const [key, value] of [
    ["hostname", "rpi5"],
    ["serviceLogs", "raw logs"],
    ["filesystemPath", "/srv/app"],
    ["sshTarget", "user@host"],
    ["secret", "do-not-accept"],
  ] as const) {
    expectError("UNEXPECTED_FIELD", () =>
      normalizeSanitizedProductionVisibility({ ...evidence(), [key]: value }, NOW),
    );
  }
});

test("strict sanitized ingestion rejects malformed, missing and inherited input", () => {
  expectError("INVALID_INPUT", () => normalizeSanitizedProductionVisibility(null, NOW));
  expectError("INVALID_INPUT", () => normalizeSanitizedProductionVisibility([], NOW));

  const missing = { ...evidence() } as Record<string, unknown>;
  delete missing.productionSha;
  expectError("INVALID_INPUT", () => normalizeSanitizedProductionVisibility(missing, NOW));

  const inherited = Object.create({ observedAt: OBSERVED_AT }) as Record<string, unknown>;
  Object.assign(inherited, evidence());
  delete inherited.observedAt;
  expectError("INVALID_INPUT", () => normalizeSanitizedProductionVisibility(inherited, NOW));
});

test("typed normalizer fails closed on malformed repository runtime input", () => {
  expectError("INVALID_INPUT", () =>
    normalizeProductionVisibility(
      { ...evidence(), repository: 42 as unknown as string },
      NOW,
    ),
  );
});

test("derives in-sync only from exact main and production SHA equality", () => {
  const result = normalizeProductionVisibility(
    evidence({ productionSha: MAIN, blockerCodes: [] }),
    NOW,
  );

  assert.equal(result.drift, "IN_SYNC");
});

test("fails closed on stale or future evidence", () => {
  expectError("STALE_EVIDENCE", () =>
    normalizeProductionVisibility(evidence(), "2026-09-01T08:05:00.001Z"),
  );
  expectError("STALE_EVIDENCE", () =>
    normalizeProductionVisibility(evidence(), "2026-09-01T07:59:59.999Z"),
  );
});

test("fails closed on contradictory runtime and health evidence", () => {
  expectError("CONTRADICTORY_EVIDENCE", () =>
    normalizeProductionVisibility(evidence({ runtime: "UNREACHABLE", health: "PASS" }), NOW),
  );
});

test("rejects unmanaged identities and projects without an RPi5 production adapter", () => {
  expectError("REPOSITORY_NOT_ALLOWED", () =>
    normalizeProductionVisibility(
      evidence({ projectId: "unknown", repository: "example/unknown" }),
      NOW,
    ),
  );
  expectError("PRODUCTION_ADAPTER_UNSUPPORTED", () =>
    normalizeProductionVisibility(
      evidence({ projectId: "ops-workflows", repository: "rozkalnsandris/ops-workflows" }),
      NOW,
    ),
  );
});

test("rejects identity mismatch, malformed SHAs and unbounded blocker text", () => {
  expectError("IDENTITY_MISMATCH", () =>
    normalizeProductionVisibility(evidence({ projectId: "hermes-deals" }), NOW),
  );
  expectError("INVALID_INPUT", () =>
    normalizeProductionVisibility(evidence({ productionSha: "not-a-sha" }), NOW),
  );
  expectError("INVALID_INPUT", () =>
    normalizeProductionVisibility(evidence({ blockerCodes: ["raw blocker message with spaces"] }), NOW),
  );
  expectError("DUPLICATE_BLOCKER", () =>
    normalizeProductionVisibility(
      evidence({ blockerCodes: ["PRODUCTION_SHA_BEHIND_MAIN", "PRODUCTION_SHA_BEHIND_MAIN"] }),
      NOW,
    ),
  );
});

test("production visibility source boundary stays pure and read-only", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/shared/production-visibility.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\benv\s*\./);
  assert.doesNotMatch(source, /wrangler|ssh|sudo|INSERT|UPDATE|DELETE|Cloudflare/i);
});
