import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateGitHubRateLimitHealth,
  isGitHubRateLimitHealth,
  normalizeGitHubRateLimitHealth,
} from "../src/shared/github-rate-limit-health.js";

const observedAt = "2026-09-03T12:00:00.000Z";
const resetAt = "2026-09-03T13:00:00.000Z";

function evidence(overrides: Partial<{
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  resource: string | null;
}> = {}) {
  return {
    limit: 5000,
    remaining: 4000,
    used: 1000,
    resetAt,
    resource: "core",
    ...overrides,
  };
}

test("missing and malformed GitHub rate-limit evidence remain UNKNOWN", () => {
  assert.equal(normalizeGitHubRateLimitHealth(null, observedAt).status, "UNKNOWN");
  for (const malformed of [
    evidence({ limit: null }),
    evidence({ remaining: null }),
    evidence({ used: -1 }),
    evidence({ remaining: 5001 }),
    evidence({ resetAt: "not-a-time" }),
    evidence({ resource: "core\nsecret" }),
  ]) {
    const health = normalizeGitHubRateLimitHealth(malformed, observedAt);
    assert.deepEqual(health, {
      status: "UNKNOWN",
      limit: null,
      remaining: null,
      used: null,
      resetAt: null,
      resource: null,
      observedAt: null,
    });
    assert.equal(isGitHubRateLimitHealth(health), true);
  }
});

test("normal, near-limit and exhausted evidence map to bounded operator health", () => {
  assert.equal(normalizeGitHubRateLimitHealth(evidence(), observedAt).status, "HEALTHY");
  assert.equal(normalizeGitHubRateLimitHealth(evidence({ remaining: 500, used: 4500 }), observedAt).status, "ATTENTION");
  assert.equal(normalizeGitHubRateLimitHealth(evidence({ remaining: 50, used: 4950 }), observedAt).status, "ATTENTION");
  assert.equal(normalizeGitHubRateLimitHealth(evidence({ remaining: 0, used: 5000 }), observedAt).status, "EXHAUSTED");
});

test("aggregate chooses the most depleted valid response and never invents evidence", () => {
  assert.equal(aggregateGitHubRateLimitHealth([], observedAt).status, "UNKNOWN");
  const health = aggregateGitHubRateLimitHealth([
    evidence({ remaining: 4000, used: 1000 }),
    evidence({ remaining: 49, used: 4951 }),
    evidence({ remaining: 2000, used: 3000 }),
  ], observedAt);
  assert.equal(health.status, "ATTENTION");
  assert.equal(health.remaining, 49);
  assert.equal(health.resource, "core");
  assert.equal(health.observedAt, observedAt);
});
