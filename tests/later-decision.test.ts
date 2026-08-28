import assert from "node:assert/strict";
import test from "node:test";

import type { DecisionReadModel } from "../src/shared/control-model.js";
import {
  createLaterDeferral,
  evaluateLaterDeferral,
  laterDecisionStateFingerprint,
  LaterDecisionError,
} from "../src/shared/later-decision.js";

function decision(overrides: Partial<DecisionReadModel> = {}): DecisionReadModel {
  return {
    id: "github:hermes-deals:pr:517",
    projectId: "hermes-deals",
    workflowState: "NEEDS_ANDRIS",
    issueNumber: 514,
    issueTitle: "Remove frontend archaeology",
    prNumber: 517,
    prTitle: "ui: remove W5B frontend archaeology",
    prUrl: "https://github.com/rozkalnsandris/hermes-deals/pull/517",
    ci: "PASS",
    review: "PASS",
    deployImpact: "NO_DEPLOY",
    changedFiles: 13,
    expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    reason: "Owner decision required",
    lastReconciledAt: "2026-08-28T07:30:00.000Z",
    allowedActions: ["OPEN_PR", "LATER", "MERGE", "NEEDS_CHANGES"],
    ...overrides,
  };
}

function expectLaterError(code: LaterDecisionError["code"], action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof LaterDecisionError && error.code === code);
}

test("Later creates bounded evidence for the exact current material decision state", () => {
  const item = decision();
  const evidence = createLaterDeferral(item, "2026-08-28T07:31:00.000Z");

  assert.deepEqual(evidence, {
    schemaVersion: 1,
    decisionId: "github:hermes-deals:pr:517",
    projectId: "hermes-deals",
    issueNumber: 514,
    prNumber: 517,
    stateFingerprint: laterDecisionStateFingerprint(item),
    deferredAt: "2026-08-28T07:31:00.000Z",
  });
  assert.match(evidence.stateFingerprint, /^later-v1-[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /reason|prTitle|issueTitle|prUrl|allowedActions/);
});

test("unchanged decision remains deferred when only reconciliation/display metadata changes", () => {
  const original = decision();
  const evidence = createLaterDeferral(original, "2026-08-28T07:31:00.000Z");
  const refreshed = decision({
    lastReconciledAt: "2026-08-28T07:40:00.000Z",
    issueTitle: "Retitled issue",
    prTitle: "Retitled PR",
    prUrl: "https://github.com/rozkalnsandris/hermes-deals/pull/517?updated=1",
    allowedActions: ["MERGE", "LATER", "OPEN_PR", "NEEDS_CHANGES"],
  });

  assert.equal(laterDecisionStateFingerprint(original), laterDecisionStateFingerprint(refreshed));
  assert.deepEqual(evaluateLaterDeferral(evidence, refreshed), {
    kind: "DEFERRED_UNCHANGED",
    stateFingerprint: evidence.stateFingerprint,
  });
});

test("material authority drift releases the old deferral", () => {
  const original = decision();
  const evidence = createLaterDeferral(original, "2026-08-28T07:31:00.000Z");

  const changedHead = decision({
    expectedHeadSha: "cccccccccccccccccccccccccccccccccccccccc",
    currentHeadSha: "cccccccccccccccccccccccccccccccccccccccc",
    reason: "Owner decision required after source changed",
  });
  const result = evaluateLaterDeferral(evidence, changedHead);

  assert.equal(result.kind, "RELEASE_MATERIAL_CHANGE");
  if (result.kind !== "RELEASE_MATERIAL_CHANGE") return;
  assert.equal(result.previousStateFingerprint, evidence.stateFingerprint);
  assert.equal(result.currentStateFingerprint, laterDecisionStateFingerprint(changedHead));
  assert.notEqual(result.currentStateFingerprint, result.previousStateFingerprint);
});

test("loss of Later authority is material drift rather than silent continued suppression", () => {
  const original = decision();
  const evidence = createLaterDeferral(original, "2026-08-28T07:31:00.000Z");
  const noLongerDeferrable = decision({ allowedActions: ["OPEN_PR"] });

  assert.equal(evaluateLaterDeferral(evidence, noLongerDeferrable).kind, "RELEASE_MATERIAL_CHANGE");
});

test("decision or project identity mismatch fails closed", () => {
  const evidence = createLaterDeferral(decision(), "2026-08-28T07:31:00.000Z");

  expectLaterError("IDENTITY_MISMATCH", () =>
    evaluateLaterDeferral(evidence, decision({ id: "github:hermes-deals:pr:518", prNumber: 518 })),
  );
  expectLaterError("IDENTITY_MISMATCH", () =>
    evaluateLaterDeferral(evidence, decision({ projectId: "hermes-tech" })),
  );
});

test("Later fails closed when action authority or evidence is malformed", () => {
  expectLaterError("ACTION_NOT_ALLOWED", () =>
    createLaterDeferral(decision({ allowedActions: ["OPEN_PR"] }), "2026-08-28T07:31:00.000Z"),
  );
  expectLaterError("INVALID_INPUT", () =>
    createLaterDeferral(decision(), "2026-08-28T07:31:00Z"),
  );

  const evidence = createLaterDeferral(decision(), "2026-08-28T07:31:00.000Z");
  expectLaterError("INVALID_INPUT", () =>
    evaluateLaterDeferral({ ...evidence, stateFingerprint: "later-v1-invalid" }, decision()),
  );
  expectLaterError("INVALID_INPUT", () =>
    evaluateLaterDeferral(evidence, decision({ mainSha: "not-a-sha" })),
  );
});
