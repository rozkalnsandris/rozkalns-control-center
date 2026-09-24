import assert from "node:assert/strict";
import test from "node:test";

import { handleGitHubOwnerActionRequest, OwnerActionRuntimeError, type OwnerActionDispatchInput, type OwnerActionWorkerRuntime } from "../src/worker/github-owner-action-route.js";

function runtime(): OwnerActionWorkerRuntime {
  return { authenticator: { async authenticateRequest() { return {}; } }, async dispatch() { throw new Error("dispatch must not be reached without a reviewed mapping"); } };
}
function request(body: unknown) { return new Request("https://control.example/api/github/owner-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
const sha = "a".repeat(40);

test("owner action route rejects unknown action", async () => {
  const response = await handleGitHubOwnerActionRequest(request({ action: "PAUSE", repository: "rozkalnsandris/hermes-deals", expectedMainSha: sha, requestId: "rc_pause_1234567890123456" }), runtime());
  assert.equal(response.status, 400);
});

test("owner action route fails closed when reviewed mapping is absent", async () => {
  const response = await handleGitHubOwnerActionRequest(request({ action: "CONTINUE", repository: "rozkalnsandris/hermes-deals", expectedMainSha: sha, requestId: "rc_continue_123456789012" }), runtime());
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "ACTION_NOT_ALLOWED" });
});

test("owner action route passes Hermes LIVE only to the reviewed workflow target", async () => {
  let captured: OwnerActionDispatchInput | null = null;
  const liveRuntime: OwnerActionWorkerRuntime = {
    authenticator: { async authenticateRequest() { return {}; } },
    async dispatch(input) {
      captured = input;
      return { status: "DISPATCHED", action: input.action, repository: input.repository, workflow: input.target.workflow, ref: input.target.ref, expectedMainSha: input.expectedMainSha, observedMainSha: input.expectedMainSha, requestId: input.requestId };
    },
  };
  const response = await handleGitHubOwnerActionRequest(request({ action: "LIVE", repository: "rozkalnsandris/hermes-deals", expectedMainSha: sha, requestId: "rc_live_1234567890123456" }), liveRuntime);
  assert.equal(response.status, 200);
  assert.deepEqual(captured?.target, { workflow: "deploy-main.yml", ref: "main", dispatchContract: "deploy-sha-confirmation-v1" });
});

test("stale main and missing Actions permission have explicit fail-closed codes", () => {
  assert.equal(new OwnerActionRuntimeError("STALE_MAIN_SHA").code, "STALE_MAIN_SHA");
  assert.equal(new OwnerActionRuntimeError("ACTIONS_PERMISSION_REQUIRED").code, "ACTIONS_PERMISSION_REQUIRED");
});
