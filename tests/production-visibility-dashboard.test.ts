import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { controlFixtures } from "../src/shared/control-fixtures.js";
import { productionVisibilityForProject } from "../src/shared/control-model.js";
import { readLiveDashboardSnapshot } from "../src/shared/live-dashboard.js";

test("fixture dashboard surfaces sanitized production drift without inventing evidence", () => {
  const inSync = productionVisibilityForProject(controlFixtures, "hermes-tech");
  const drifted = productionVisibilityForProject(controlFixtures, "rpi5-main");
  const unavailable = productionVisibilityForProject(controlFixtures, "rozkalns-cv");

  assert.equal(inSync?.drift, "IN_SYNC");
  assert.equal(inSync?.runtime, "HEALTHY");
  assert.equal(drifted?.drift, "DRIFTED");
  assert.deepEqual(drifted?.blockerCodes, ["PRODUCTION_SHA_BEHIND_MAIN", "RUNTIME_HEALTH_FAILED"]);
  assert.equal(unavailable, null);
});

test("live GitHub dashboard does not synthesize production visibility", async () => {
  const source = readFileSync(resolve(process.cwd(), "src/shared/live-dashboard.ts"), "utf8");
  assert.match(source, /productionVisibility:\s*\[\]/);
  assert.doesNotMatch(source, /ssh|sudo|wrangler|productionSha|normalizeProductionVisibility/i);
  assert.equal(typeof readLiveDashboardSnapshot, "function");
});

test("React dashboard validates and displays sanitized production visibility", () => {
  const source = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
  assert.match(source, /Array\.isArray\(value\.productionVisibility\)/);
  assert.match(source, /productionVisibilityForProject/);
  assert.match(source, /Production visibility/);
  assert.match(source, /No sanitized production evidence is available in this snapshot/);
});
