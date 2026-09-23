import assert from "node:assert/strict";
import test from "node:test";

import { OWNER_ACTIONS, OWNER_ACTION_LABELS } from "../src/shared/owner-action-model.js";
import { resolveManagedProjectPolicy, resolveOwnerWorkflowTarget } from "../src/shared/project-policy.js";

test("owner panel is intentionally exactly Merge Live Continue", () => {
  assert.deepEqual(OWNER_ACTIONS, ["MERGE", "LIVE", "CONTINUE"]);
  assert.deepEqual(OWNER_ACTIONS.map((action) => OWNER_ACTION_LABELS[action]), ["Merge", "Live", "Continue"]);
});

test("workflow actions fail closed until a reviewed mapping exists", () => {
  const policy = resolveManagedProjectPolicy("rozkalnsandris/hermes-deals");
  assert.equal(policy?.canLive, true);
  assert.equal(policy?.canContinue, true);
  assert.equal(resolveOwnerWorkflowTarget("rozkalnsandris/hermes-deals", "LIVE"), null);
  assert.equal(resolveOwnerWorkflowTarget("rozkalnsandris/hermes-deals", "CONTINUE"), null);
});
