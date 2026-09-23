import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionReadModel, ProjectReadModel } from "../src/shared/control-model.js";
import { buildDecisionActionRequest, DecisionActionClientError, type DecisionActionTarget } from "../src/react-app/decision-action-client.js";

const project: ProjectReadModel = { id: "ops-workflows", displayName: "Ops Workflows", repository: "rozkalnsandris/ops-workflows", enabled: true, productionAdapter: "none", status: "ATTENTION", openPullRequests: 1, openIssues: 1 };
function decision(overrides: Partial<DecisionReadModel> = {}): DecisionReadModel { return { id: "github:ops-workflows:pr:5", projectId: "ops-workflows", workflowState: "NEEDS_ANDRIS", issueNumber: 4, issueTitle: "Canary issue", prNumber: 5, prTitle: "Canary pull request", prUrl: "https://github.com/rozkalnsandris/ops-workflows/pull/5", ci: "PASS", review: "PASS", deployImpact: "NO_DEPLOY", changedFiles: 2, expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", reason: "Owner decision required", lastReconciledAt: "2026-08-28T08:00:00.000Z", allowedActions: ["MERGE"], actionStates: { OPEN_PR: { state: "enabled", reason: null }, MERGE: { state: "enabled", reason: null }, NEEDS_CHANGES: { state: "unavailable", reason: "Legacy action" }, LATER: { state: "unavailable", reason: "Legacy action" }, RETRY_CI: { state: "unavailable", reason: "Legacy action" }, CONTINUE: { state: "disabled", reason: "Workflow mapping required" }, PAUSE: { state: "unavailable", reason: "Legacy action" } }, ...overrides }; }
function target(action: DecisionActionTarget["action"], item = decision()): DecisionActionTarget { return { action, item, project }; }
function expectClientError(code: string, action: () => unknown): void { assert.throws(action, (error: unknown) => error instanceof DecisionActionClientError && error.code === code); }

test("Merge request binds exact decision evidence and explicit squash method", () => {
  const request = buildDecisionActionRequest(target("MERGE"), { requestIdFactory: () => "merge_request_1234567890" });
  assert.deepEqual(request, { path: "/api/github/merge", body: { repository: "rozkalnsandris/ops-workflows", issueNumber: 4, pullNumber: 5, expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expectedMainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", requestId: "merge_request_1234567890", mergeMethod: "squash" } });
});

test("Live and Continue fail closed while reviewed workflow mappings are absent", () => {
  for (const action of ["LIVE", "CONTINUE"] as const) {
    expectClientError("ACTION_NOT_ALLOWED", () => buildDecisionActionRequest(target(action), { requestIdFactory: () => `owner_${action.toLowerCase()}_1234567890` }));
  }
});

test("stale head and missing Merge authority fail before any request is built", () => {
  expectClientError("STALE_DECISION_HEAD", () => buildDecisionActionRequest(target("MERGE", decision({ currentHeadSha: "cccccccccccccccccccccccccccccccccccccccc" })), { requestIdFactory: () => "merge_request_1234567890" }));
  expectClientError("ACTION_NOT_ALLOWED", () => buildDecisionActionRequest(target("MERGE", decision({ allowedActions: ["OPEN_PR"], actionStates: { ...decision().actionStates!, MERGE: { state: "disabled", reason: "Not allowed" } } }))));
});

test("expired confirmation cannot submit Merge", () => {
  expectClientError("ACTION_ELIGIBILITY_EXPIRED", () => buildDecisionActionRequest(target("MERGE", decision({ actionEligibilityExpiresAt: Date.now() - 1 })), { requestIdFactory: () => "merge_request_1234567890" }));
});
