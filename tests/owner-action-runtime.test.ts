import assert from "node:assert/strict";
import test from "node:test";

import { buildOwnerActionWorkflowDispatchInputs } from "../src/worker/github-owner-action-runtime.js";
import type { OwnerActionDispatchInput } from "../src/worker/github-owner-action-route.js";

const sha = "a".repeat(40);

function input(action: OwnerActionDispatchInput["action"], dispatchContract: OwnerActionDispatchInput["target"]["dispatchContract"]): OwnerActionDispatchInput {
  return {
    action,
    repository: "rozkalnsandris/hermes-deals",
    target: { workflow: "deploy-main.yml", ref: "main", dispatchContract },
    expectedMainSha: sha,
    requestId: "rc_live_1234567890123456",
  };
}

test("reviewed Hermes LIVE contract sends only exact SHA and typed deploy confirmation", () => {
  assert.deepEqual(buildOwnerActionWorkflowDispatchInputs(input("LIVE", "deploy-sha-confirmation-v1")), {
    target_sha: sha,
    confirmation: `DEPLOY ${sha}`,
  });
});

test("deploy SHA confirmation contract rejects non-LIVE owner actions", () => {
  assert.throws(
    () => buildOwnerActionWorkflowDispatchInputs(input("CONTINUE", "deploy-sha-confirmation-v1")),
    /DISPATCH_REJECTED/,
  );
});

test("generic owner-action contract preserves explicit Control fields", () => {
  assert.deepEqual(buildOwnerActionWorkflowDispatchInputs(input("CONTINUE", "owner-action-v1")), {
    control_action: "CONTINUE",
    expected_main_sha: sha,
    control_request_id: "rc_live_1234567890123456",
  });
});
