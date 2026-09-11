import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { controlFixtures } from "../src/shared/control-fixtures.js";
import { productionVisibilityForProject } from "../src/shared/control-model.js";
import { readLiveDashboardSnapshot } from "../src/shared/live-dashboard.js";
import { deriveProductionVisibilityHealth } from "../src/shared/production-visibility-health.js";

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

test("fixture production health derives HEALTHY, DRIFTED and NOT_OBSERVED without mutation authority", () => {
  const hermes = controlFixtures.projects.find((project) => project.id === "hermes-tech");
  const rpi5 = controlFixtures.projects.find((project) => project.id === "rpi5-main");
  const cv = controlFixtures.projects.find((project) => project.id === "rozkalns-cv");
  assert.ok(hermes && hermes.productionAdapter === "rpi5");
  assert.ok(rpi5 && rpi5.productionAdapter === "rpi5");
  assert.ok(cv && cv.productionAdapter === "rpi5");

  const hermesHealth = deriveProductionVisibilityHealth(
    { id: hermes.id, repository: hermes.repository, productionAdapter: "rpi5" },
    productionVisibilityForProject(controlFixtures, hermes.id),
    controlFixtures.generatedAt,
  );
  const rpi5Health = deriveProductionVisibilityHealth(
    { id: rpi5.id, repository: rpi5.repository, productionAdapter: "rpi5" },
    productionVisibilityForProject(controlFixtures, rpi5.id),
    controlFixtures.generatedAt,
  );
  const cvHealth = deriveProductionVisibilityHealth(
    { id: cv.id, repository: cv.repository, productionAdapter: "rpi5" },
    productionVisibilityForProject(controlFixtures, cv.id),
    controlFixtures.generatedAt,
  );

  assert.equal(hermesHealth.status, "HEALTHY");
  assert.equal(rpi5Health.status, "DRIFTED");
  assert.equal(cvHealth.status, "NOT_OBSERVED");
  assert.equal(hermesHealth.authority.authoritativeForMutation, false);
});

test("live GitHub dashboard does not synthesize production visibility", async () => {
  const source = readFileSync(resolve(process.cwd(), "src/shared/live-dashboard.ts"), "utf8");
  assert.match(source, /productionVisibility:\s*\[\]/);
  assert.doesNotMatch(source, /ssh|sudo|wrangler|productionSha|normalizeProductionVisibility/i);
  assert.equal(typeof readLiveDashboardSnapshot, "function");
});

test("React dashboard validates and displays bounded Phase 5 production health", () => {
  const source = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
  assert.match(source, /Array\.isArray\(value\.productionVisibility\)/);
  assert.match(source, /isProductionVisibilityHealthReadModel/);
  assert.match(source, /productionVisibilityHealthForProject/);
  assert.match(source, /deriveProductionVisibilityHealth/);
  assert.match(source, /productionHealth\.status/);
  assert.match(source, /Production visibility/);
  assert.match(source, /non-authoritative/);
  assert.match(source, /Evidence only · never authorizes deploy, DB\/host work or rollback/);
  assert.doesNotMatch(source, /retry production|deploy production|rollback production/i);
});
