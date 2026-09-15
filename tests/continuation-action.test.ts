import assert from "node:assert/strict";
import test from "node:test";
import { continuationActionStates, continuationFingerprint, planContinuationAction, type FoundCampaign } from "../src/shared/continuation-action.js";
import type { ContinuationGithubReadProvider } from "../src/shared/continuation-github-snapshot.js";
import { resolveContinuationActionRuntime } from "../src/worker/continuation-action-runtime.js";
import { handleContinuationActionRequest } from "../src/worker/continuation-action-route.js";

const repository = "rozkalnsandris/ops-workflows";
const mainSha = "a".repeat(40);
const now = "2026-09-15T12:00:00.000Z";
const old = "2026-09-15T11:59:00.000Z";
function recovery(): FoundCampaign {
  return { kind: "FOUND", campaign: { schemaVersion: 1, campaignId: "campaign:ops", projectId: "ops-workflows", repository, scope: "source", mode: "CONTINUE_ISSUES", continueEnabled: false, paused: true, currentTask: null, humanGate: null, expectedMainSha: mainSha, nextTaskId: null, observedAt: old, updatedAt: old }, tasks: [{ taskId: "task:1", projectId: "ops-workflows", repository, issueNumber: 1, taskState: "DISCOVERED", activePullRequestNumber: null, expectedHeadSha: null, priority: 1, updatedAt: old }] };
}
const provider: ContinuationGithubReadProvider = {
  async getRepository() { return { repository, defaultBranch: "main" }; },
  async getDefaultBranchHead() { return mainSha; },
  async listOpenIssues() { return [{ number: 1, state: "open", title: "Task", htmlUrl: `https://github.com/${repository}/issues/1` }]; },
  async listOpenPullRequests() { return []; },
};

test("Continue resumes only defined state and selects only the existing planner unit", async () => {
  const found = recovery();
  assert.equal(continuationActionStates(found).CONTINUE.state, "enabled");
  const next = await planContinuationAction("CONTINUE", found, { provider, now: () => now });
  assert.equal(next.campaign.paused, false);
  assert.equal(next.campaign.continueEnabled, true);
  assert.equal(next.campaign.nextTaskId, "task:1");
  assert.equal(next.campaign.currentTask, null);
  assert.equal(next.plan.kind, "READY");
  assert.equal(found.campaign.paused, true);
  assert.notEqual(await continuationFingerprint(found), await continuationFingerprint({ ...found, campaign: next.campaign }));
});

test("Continue stops at every human gate and incomplete task before GitHub reads", async () => {
  const forbidden = { ...provider, getRepository: async () => { throw new Error("unexpected read"); } };
  for (const gate of ["MERGE", "DEPLOY", "NEEDS_CHANGES", "PRODUCTION_MUTATION"] as const) {
    const base = recovery(); const found: FoundCampaign = { ...base, campaign: { ...base.campaign, humanGate: gate } };
    assert.equal(continuationActionStates(found).CONTINUE.state, "disabled");
    await assert.rejects(planContinuationAction("CONTINUE", found, { provider: forbidden, now: () => now }), /HUMAN_GATE/);
  }
  const base = recovery(); const found: FoundCampaign = { ...base, campaign: { ...base.campaign, currentTask: { taskId: "task:1", state: "WORKING" } } };
  await assert.rejects(planContinuationAction("CONTINUE", found, { provider: forbidden, now: () => now }), /CURRENT_TASK_INCOMPLETE/);
});

test("Pause keeps human gate and task unchanged; repeated pause has the same state", async () => {
  const base = recovery(); const found: FoundCampaign = { ...base, campaign: { ...base.campaign, paused: false, continueEnabled: true, humanGate: "MERGE" } };
  const next = await planContinuationAction("PAUSE", found, { provider, now: () => now });
  assert.equal(next.campaign.paused, true);
  assert.equal(next.campaign.humanGate, "MERGE");
  assert.deepEqual(next.campaign.currentTask, found.campaign.currentTask);
  assert.equal(next.campaign.nextTaskId, null);
  const paused = { ...found, campaign: next.campaign };
  assert.equal(continuationActionStates(paused).PAUSE.reason, "Continuation already paused");
  const repeat = await planContinuationAction("PAUSE", paused, { provider, now: () => "2026-09-15T12:00:01.000Z" });
  assert.equal(repeat.campaign.paused, true);
  assert.equal(repeat.campaign.humanGate, "MERGE");
});

test("continuation rejects live main drift and expired evidence", async () => {
  await assert.rejects(planContinuationAction("CONTINUE", recovery(), { provider: { ...provider, async getDefaultBranchHead() { return "b".repeat(40); } }, now: () => now }), /EXPECTED_MAIN_SHA_DRIFT/);
  let calls = 0;
  await assert.rejects(planContinuationAction("CONTINUE", recovery(), { provider, now: () => calls++ === 0 ? now : "2026-09-15T12:02:00.000Z" }), /failed closed/);
});

test("missing runtime capability remains disabled and cannot inspect protected bindings", async () => {
  const bindings = { GITHUB_APP_CLIENT_ID: "unused", GITHUB_APP_INSTALLATION_ID: "1", GITHUB_APP_PRIVATE_KEY_PEM: "unused", get CONTROL_DB(): never { throw new Error("must not inspect"); } };
  assert.equal(resolveContinuationActionRuntime(bindings), null);
  const response = await handleContinuationActionRequest(new Request("https://control.invalid/api/control/continuation", { method: "POST" }), null);
  assert.equal(response.status, 503);
});
