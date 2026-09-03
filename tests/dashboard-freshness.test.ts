import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DASHBOARD_CLOCK_SKEW_MS,
  MAX_DASHBOARD_SNAPSHOT_AGE_MS,
  classifyDashboardFreshness,
} from "../src/shared/dashboard-freshness.js";
import type { ControlDashboardData } from "../src/shared/control-model.js";

const NOW_MS = Date.parse("2026-09-03T10:00:00.000Z");

function dashboard(generatedAt: string, lastReconciledAt = generatedAt): ControlDashboardData {
  return {
    generatedAt,
    projects: [],
    decisions: [{
      id: "decision-1",
      projectId: "ops-workflows",
      workflowState: "WAITING",
      issueNumber: 1,
      issueTitle: "Freshness boundary",
      prNumber: null,
      prTitle: null,
      ci: "WAITING",
      review: "NOT_REQUIRED",
      deployImpact: "NO_DEPLOY",
      changedFiles: 0,
      expectedHeadSha: null,
      currentHeadSha: null,
      mainSha: "a".repeat(40),
      reason: "Freshness test",
      lastReconciledAt,
      allowedActions: ["LATER"],
    }],
    productionVisibility: [],
  };
}

function timestamp(deltaMs = 0): string {
  return new Date(NOW_MS + deltaMs).toISOString();
}

test("dashboard freshness accepts just-inside and exact age thresholds", () => {
  assert.equal(classifyDashboardFreshness(dashboard(timestamp(-MAX_DASHBOARD_SNAPSHOT_AGE_MS + 1)), NOW_MS).state, "FRESH");
  assert.equal(classifyDashboardFreshness(dashboard(timestamp(-MAX_DASHBOARD_SNAPSHOT_AGE_MS)), NOW_MS).state, "FRESH");
});

test("dashboard freshness rejects over-age generated and decision evidence", () => {
  assert.deepEqual(
    classifyDashboardFreshness(dashboard(timestamp(-MAX_DASHBOARD_SNAPSHOT_AGE_MS - 1)), NOW_MS),
    { state: "STALE", field: "generatedAt", decisionId: null },
  );
  assert.deepEqual(
    classifyDashboardFreshness(dashboard(timestamp(), timestamp(-MAX_DASHBOARD_SNAPSHOT_AGE_MS - 1)), NOW_MS),
    { state: "STALE", field: "lastReconciledAt", decisionId: "decision-1" },
  );
});

test("dashboard freshness accepts exact clock skew and rejects farther future evidence", () => {
  assert.equal(classifyDashboardFreshness(dashboard(timestamp(MAX_DASHBOARD_CLOCK_SKEW_MS)), NOW_MS).state, "FRESH");
  assert.deepEqual(
    classifyDashboardFreshness(dashboard(timestamp(), timestamp(MAX_DASHBOARD_CLOCK_SKEW_MS + 1)), NOW_MS),
    { state: "FUTURE", field: "lastReconciledAt", decisionId: "decision-1" },
  );
});

test("dashboard freshness rejects malformed and impossible UTC timestamps", () => {
  assert.equal(classifyDashboardFreshness(dashboard("not-a-time"), NOW_MS).state, "INVALID");
  assert.equal(classifyDashboardFreshness(dashboard("2026-02-31T10:00:00Z"), NOW_MS).state, "INVALID");
  assert.deepEqual(
    classifyDashboardFreshness(dashboard(timestamp(), "not-a-time"), NOW_MS),
    { state: "INVALID", field: "lastReconciledAt", decisionId: "decision-1" },
  );
});
