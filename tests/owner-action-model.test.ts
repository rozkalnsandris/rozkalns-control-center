import assert from "node:assert/strict";
import test from "node:test";

import { OWNER_ACTIONS, OWNER_ACTION_LABELS } from "../src/shared/owner-action-model.js";
import { resolveManagedProjectPolicy, resolveOwnerWorkflowTarget } from "../src/shared/project-policy.js";

test("owner panel is intentionally exactly Merge Live Continue", () => {
  assert.deepEqual(OWNER_ACTIONS, ["MERGE", "LIVE", "CONTINUE"]);
  assert.deepEqual(OWNER_ACTIONS.map((action) => OWNER_ACTION_LABELS[action]), ["Merge", "Live", "Continue"]);
});

test("Hermes LIVE resolves only the reviewed deploy workflow contract", () => {
  const policy = resolveManagedProjectPolicy("rozkalnsandris/hermes-deals");
  assert.equal(policy?.canLive, true);
  assert.equal(policy?.canContinue, true);
  assert.deepEqual(resolveOwnerWorkflowTarget("rozkalnsandris/hermes-deals", "LIVE"), {
    workflow: "deploy-main.yml",
    ref: "main",
    dispatchContract: "deploy-sha-confirmation-v1",
  });
  assert.equal(resolveOwnerWorkflowTarget("rozkalnsandris/hermes-deals", "CONTINUE"), null);
});

test("all other managed projects remain fail closed for owner workflow dispatch", () => {
  for (const repository of [
    "rozkalnsandris/hermes-tech",
    "rozkalnsandris/rozkalns-cv",
    "rozkalnsandris/RPi5_main",
    "rozkalnsandris/ops-workflows",
    "rozkalnsandris/rozkalnsandris",
  ]) {
    assert.equal(resolveOwnerWorkflowTarget(repository, "LIVE"), null);
    assert.equal(resolveOwnerWorkflowTarget(repository, "CONTINUE"), null);
  }
});
