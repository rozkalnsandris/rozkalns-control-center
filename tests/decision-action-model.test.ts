import assert from "node:assert/strict";
import test from "node:test";
import { DECISION_ACTIONS, type DecisionReadModel, type ProjectReadModel } from "../src/shared/control-model.js";
import { enabledAction, isDecisionActionStates, normalizeDecisionActions, RETRY_CI_UNAVAILABLE_REASON } from "../src/shared/decision-action-model.js";
import { retryCiEligibility, type RetryCiExecution } from "../src/shared/retry-ci.js";
import { buildDecisionActionRequest } from "../src/react-app/decision-action-client.js";
import { readContinuationEligibility } from "../src/react-app/continuation-eligibility-client.js";

const now = Date.parse("2026-09-15T12:00:00.000Z");
const project: ProjectReadModel = { id: "ops-workflows", repository: "rozkalnsandris/ops-workflows", displayName: "Ops Workflows", enabled: true, productionAdapter: "none", status: "WAITING", openIssues: 1, openPullRequests: 1 };
const decision: DecisionReadModel = { id: "github:ops-workflows:pr:5", projectId: project.id, workflowState: "MERGE_READY", issueNumber: 4, issueTitle: "Task", prNumber: 5, prTitle: "Change", prUrl: `${`https://github.com/${project.repository}`}/pull/5`, ci: "PASS", review: "PASS", deployImpact: "NO_DEPLOY", changedFiles: 1, expectedHeadSha: "a".repeat(40), currentHeadSha: "a".repeat(40), mainSha: "b".repeat(40), reason: "Owner gate", lastReconciledAt: new Date(now).toISOString(), allowedActions: ["OPEN_PR", "LATER"] };
const normalize = (item = decision, live = true) => normalizeDecisionActions(item, project, { live, nowMs: now, verifiedGitHub: { merge: true, needsChanges: true } });

test("normalized model represents every canonical action and requires explanations", () => {
  const states = normalize().actionStates!;
  assert.deepEqual(Object.keys(states), [...DECISION_ACTIONS]);
  assert.equal(isDecisionActionStates(states), true);
  assert.equal(states.MERGE.state, "enabled");
  assert.equal(states.RETRY_CI.reason, RETRY_CI_UNAVAILABLE_REASON);
  assert.equal(isDecisionActionStates({ ...states, DEPLOY: enabledAction() }), false);
  assert.equal(isDecisionActionStates({ ...states, PAUSE: { state: "working", reason: null } }), false);
  assert.equal(isDecisionActionStates({ ...states, PAUSE: { state: "disabled", reason: "" } }), false);
  const { PAUSE: omitted, ...missing } = states;
  assert.ok(omitted);
  assert.equal(isDecisionActionStates(missing), false);
});

test("fixture stale future invalid and failed-read state never enable mutations", () => {
  for (const item of [normalize(decision, false), normalize({ ...decision, lastReconciledAt: "invalid" }), normalize({ ...decision, lastReconciledAt: new Date(now + 1).toISOString() }), normalize({ ...decision, lastReconciledAt: new Date(now - 300001).toISOString() }), normalizeDecisionActions(decision, project, { live: true, nowMs: now, blockedReason: "Live read failed" })]) {
    for (const action of DECISION_ACTIONS.filter((value) => value !== "OPEN_PR")) {
      assert.notEqual(item.actionStates![action].state, "enabled");
      assert.ok(item.actionStates![action].reason);
    }
  }
});

test("Merge presentation requires verified exact-head CI and review evidence", () => {
  assert.equal(normalizeDecisionActions(decision, project, { live: true, nowMs: now }).actionStates?.MERGE.state, "disabled");
  for (const delta of [{ currentHeadSha: "c".repeat(40) }, { ci: "FAIL" as const }, { review: "PENDING" as const }, { prNumber: null }]) {
    assert.equal(normalize({ ...decision, ...delta }).actionStates?.MERGE.state, "disabled");
  }
  assert.equal(normalize({ ...decision, prUrl: "https://example.com/wrong" }).actionStates?.OPEN_PR.state, "unavailable");
});

test("Continue/Pause client binds campaign revision and cannot route to merge/deploy", () => {
  for (const action of ["CONTINUE", "PAUSE"] as const) {
    const item = normalize();
    item.actionStates![action] = enabledAction();
    item.continuation = { campaignId: "campaign:ops", revision: "c".repeat(64), expectedMainSha: item.mainSha };
    const request = buildDecisionActionRequest({ item, project, action }, { requestIdFactory: () => "continuation_request_12345" });
    assert.equal(request.path, "/api/control/continuation");
    assert.equal(request.body.action, action);
    assert.equal(request.body.revision, item.continuation.revision);
    assert.equal(request.body.mergeMethod, undefined);
  }
});

test("Retry CI is exact execution-bound and fail-closed even with forged cached permission", () => {
  const execution: RetryCiExecution = { repository: project.repository, runId: 123, runAttempt: 2, headSha: "a".repeat(40), status: "completed", conclusion: "failure", observedAt: new Date(now).toISOString() };
  assert.equal(retryCiEligibility(execution, execution, now).reason, RETRY_CI_UNAVAILABLE_REASON);
  for (const delta of [{ repository: "other/repo" }, { runId: 124 }, { runAttempt: 3 }, { headSha: "b".repeat(40) }, { status: "queued" as const }, { conclusion: "success" as const }, { observedAt: "bad" }, { observedAt: new Date(now - 60001).toISOString() }]) {
    const state = retryCiEligibility(execution, { ...execution, ...delta }, now);
    assert.notEqual(state.state, "enabled");
    assert.notEqual(state.reason, RETRY_CI_UNAVAILABLE_REASON);
  }
  const item = normalize(); item.actionStates!.RETRY_CI = enabledAction(); item.allowedActions.push("RETRY_CI");
  assert.throws(() => buildDecisionActionRequest({ action: "RETRY_CI", item, project }), /Decision action failed/);
});


test("expired confirmation cannot submit a mutation", () => {
  const item = normalize();
  item.actionEligibilityExpiresAt = Date.now() - 1;
  assert.throws(() => buildDecisionActionRequest({ action: "LATER", item, project }), /Decision action failed/);
});

test("continuation Access denial remains disabled and never follows a login redirect", async (context) => {
  const item = { ...decision, lastReconciledAt: new Date().toISOString() };
  let response = new Response(null, { status: 403 });
  const fetchMock = context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "same-origin");
    return response;
  });
  for (const status of [301, 302, 401, 403]) {
    response = new Response(null, { status });
    const result = await readContinuationEligibility(item, project, new AbortController().signal);
    assert.equal(result.states.CONTINUE.state, "disabled");
    assert.match(result.states.CONTINUE.reason!, /Owner sign-in required/);
    assert.deepEqual(result.states.PAUSE, result.states.CONTINUE);
    assert.equal(result.continuation, undefined);
  }
  response = new Response(null);
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  assert.match((await readContinuationEligibility(item, project, new AbortController().signal)).states.CONTINUE.reason!, /Owner sign-in required/);
  response = new Response(null, { status: 503 });
  assert.match((await readContinuationEligibility(item, project, new AbortController().signal)).states.CONTINUE.reason!, /runtime unavailable/);
  assert.equal(fetchMock.mock.callCount(), 6);
});
