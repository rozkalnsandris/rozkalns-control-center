import assert from "node:assert/strict";
import test from "node:test";

import { controlFixtures } from "../src/shared/control-fixtures.js";
import { decisionsForState, projectById, summarizeDashboard } from "../src/shared/control-model.js";

const sha40 = /^[0-9a-f]{40}$/;

test("control fixtures reference known projects and valid SHA evidence", () => {
  for (const decision of controlFixtures.decisions) {
    assert.doesNotThrow(() => projectById(controlFixtures, decision.projectId));
    assert.match(decision.mainSha, sha40);
    if (decision.expectedHeadSha) assert.match(decision.expectedHeadSha, sha40);
    if (decision.currentHeadSha) assert.match(decision.currentHeadSha, sha40);
  }
});

test("Needs Andris fixtures expose explicit human choices", () => {
  const needsAndris = decisionsForState(controlFixtures, "NEEDS_ANDRIS");
  assert.equal(needsAndris.length, 2);

  for (const decision of needsAndris) {
    assert.equal(decision.ci, "PASS");
    assert.equal(decision.review, "PASS");
    assert.ok(decision.allowedActions.includes("MERGE"));
    assert.ok(decision.allowedActions.includes("NEEDS_CHANGES"));
    assert.ok(decision.allowedActions.includes("LATER"));
  }
});

test("failed or in-progress work cannot expose mock merge", () => {
  const blockedStates = decisionsForState(controlFixtures, "WORKING", "WAITING", "CI_FAILED");
  for (const decision of blockedStates) {
    assert.equal(decision.allowedActions.includes("MERGE"), false);
  }
});

test("dashboard summary is deterministic", () => {
  assert.deepEqual(summarizeDashboard(controlFixtures), {
    needsAndris: 2,
    workingOrWaiting: 2,
    ciFailed: 1,
    mergeReady: 1,
    enabledProjects: 6,
  });
});
