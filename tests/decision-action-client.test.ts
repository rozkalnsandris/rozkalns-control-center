import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionReadModel, ProjectReadModel } from "../src/shared/control-model.js";
import { laterDecisionStateFingerprint } from "../src/shared/later-decision.js";
import { buildDecisionActionRequest, DecisionActionClientError, type DecisionActionTarget } from "../src/react-app/decision-action-client.js";

const project: ProjectReadModel = { id: "ops-workflows", displayName: "Ops Workflows", repository: "rozkalnsandris/ops-workflows", enabled: true, productionAdapter: "none", status: "ATTENTION", openPullRequests: 1, openIssues: 1 };
function decision(overrides: Partial<DecisionReadModel> = {}): DecisionReadModel { return { id: "github:ops-workflows:pr:5", projectId: "ops-workflows", workflowState: "NEEDS_ANDRIS", issueNumber: 4, issueTitle: "Canary issue", prNumber: 5, prTitle: "Canary pull request", prUrl: "https://github.com/rozkalnsandris/ops-workflows/pull/5", ci: "PASS", review: "PASS", deployImpact: "NO_DEPLOY", changedFiles: 2, expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", reason: "Owner decision required", lastReconciledAt: "2026-08-28T08:00:00.000Z", allowedActions: ["MERGE", "NEEDS_CHANGES", "LATER", "OPEN_PR"], ...overrides }; }
function target(action: DecisionActionTarget["action"], item = decision()): DecisionActionTarget { return { action, item, project }; }
function expectClientError(code: string, action: () => unknown): void { assert.throws(action, (error: unknown) => error instanceof DecisionActionClientError && error.code === code); }

test("Merge request binds exact decision evidence and explicit squash method", () => {
  const request = buildDecisionActionRequest(target("MERGE"), { requestIdFactory: () => "merge_request_1234567890" });
  assert.deepEqual(request, { path: "/api/github/merge", body: { repository: "rozkalnsandris/ops-workflows", issueNumber: 4, pullNumber: 5, expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expectedMainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", requestId: "merge_request_1234567890", mergeMethod: "squash" } });
});

test("Needs changes trims and binds a bounded explicit review message", () => {
  const request = buildDecisionActionRequest(target("NEEDS_CHANGES"), { reviewBody: "  Please address the failing edge case.  ", requestIdFactory: () => "needs_request_123456789" });
  assert.equal(request.path, "/api/github/needs-changes"); assert.equal(request.body.body, "Please address the failing edge case."); assert.equal(request.body.expectedHeadSha, decision().expectedHeadSha); assert.equal(request.body.expectedMainSha, decision().mainSha);
});

test("Later request uses the deterministic material-state fingerprint", () => {
  const item = decision(); const request = buildDecisionActionRequest(target("LATER", item));
  assert.deepEqual(request, { path: "/api/github/later", body: { repository: "rozkalnsandris/ops-workflows", decisionId: item.id, expectedStateFingerprint: laterDecisionStateFingerprint(item) } });
});

test("stale head and missing action authority fail before any request is built", () => {
  expectClientError("STALE_DECISION_HEAD", () => buildDecisionActionRequest(target("MERGE", decision({ currentHeadSha: "cccccccccccccccccccccccccccccccccccccccc" })), { requestIdFactory: () => "merge_request_1234567890" }));
  expectClientError("ACTION_NOT_ALLOWED", () => buildDecisionActionRequest(target("MERGE", decision({ allowedActions: ["OPEN_PR"] }))));
});

test("Needs changes rejects empty and over-limit review messages", () => {
  expectClientError("REVIEW_MESSAGE_REQUIRED", () => buildDecisionActionRequest(target("NEEDS_CHANGES"), { reviewBody: "   ", requestIdFactory: () => "needs_request_123456789" }));
  expectClientError("REVIEW_MESSAGE_TOO_LONG", () => buildDecisionActionRequest(target("NEEDS_CHANGES"), { reviewBody: "€".repeat(1400), requestIdFactory: () => "needs_request_123456789" }));
});
