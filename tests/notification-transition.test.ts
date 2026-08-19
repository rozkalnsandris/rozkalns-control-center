import assert from "node:assert/strict";
import test from "node:test";

import type { DecisionReadModel } from "../src/shared/control-model.js";
import {
  evaluateNotificationTransition,
  notificationCandidateForDecision,
  notificationSignalForDecision,
  notificationTransitionId,
} from "../src/shared/notification-transition.js";

function decision(overrides: Partial<DecisionReadModel> = {}): DecisionReadModel {
  return {
    id: "github:hermes-deals:pr:517",
    projectId: "hermes-deals",
    workflowState: "WORKING",
    issueNumber: 514,
    issueTitle: "Remove frontend archaeology",
    prNumber: 517,
    prTitle: "ui: remove W5B frontend archaeology",
    prUrl: "https://github.com/rozkalnsandris/hermes-deals/pull/517",
    ci: "RUNNING",
    review: "PENDING",
    deployImpact: "UNKNOWN",
    changedFiles: 13,
    expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    reason: "Waiting for CI",
    lastReconciledAt: "2026-08-19T18:51:00.000Z",
    allowedActions: ["OPEN_PR"],
    ...overrides,
  };
}

test("only normalized high-signal Daily MVP states are notification eligible", () => {
  assert.equal(notificationSignalForDecision(decision()), null);
  assert.equal(
    notificationSignalForDecision(
      decision({ workflowState: "NEEDS_ANDRIS", reason: "Owner decision required" }),
    ),
    "NEEDS_ANDRIS",
  );
  assert.equal(
    notificationSignalForDecision(decision({ workflowState: "CI_FAILED", ci: "FAIL" })),
    "CI_FAILED",
  );
  assert.equal(
    notificationSignalForDecision(decision({ workflowState: "CI_FAILED", ci: "RUNNING" })),
    null,
  );
});

test("a new high-signal transition emits one provider-neutral exact-decision candidate", () => {
  const current = decision({
    workflowState: "CI_FAILED",
    ci: "FAIL",
    reason: "Required CI failed and needs operator review",
  });
  const result = evaluateNotificationTransition(decision(), current);

  assert.equal(result.kind, "NEW_TRANSITION");
  if (result.kind !== "NEW_TRANSITION") return;

  assert.deepEqual(result.candidate, {
    schemaVersion: 1,
    signal: "CI_FAILED",
    transitionId: notificationTransitionId(current, "CI_FAILED"),
    decisionId: "github:hermes-deals:pr:517",
    projectId: "hermes-deals",
    reference: "PR #517",
    title: "ui: remove W5B frontend archaeology",
    body: "Required CI failed and needs operator review",
    deepLinkPath: "/#decision-6769746875623a6865726d65732d6465616c733a70723a353137",
  });
});

test("unchanged repeated observations are deduped even when reconciliation time changes", () => {
  const first = decision({
    workflowState: "NEEDS_ANDRIS",
    ci: "PASS",
    reason: "Approve the reviewed source gate",
  });
  const repeated = {
    ...first,
    lastReconciledAt: "2026-08-19T18:59:00.000Z",
  };

  assert.equal(
    notificationTransitionId(first, "NEEDS_ANDRIS"),
    notificationTransitionId(repeated, "NEEDS_ANDRIS"),
  );
  assert.deepEqual(evaluateNotificationTransition(first, repeated), {
    kind: "NO_SIGNAL",
    reason: "UNCHANGED",
  });
});

test("material decision changes create a new deterministic transition identity", () => {
  const previous = decision({
    workflowState: "NEEDS_ANDRIS",
    ci: "PASS",
    reason: "Approve head aaaaaaa",
  });
  const current = decision({
    workflowState: "NEEDS_ANDRIS",
    ci: "PASS",
    reason: "Approve head ccccccc after source changed",
    expectedHeadSha: "cccccccccccccccccccccccccccccccccccccccc",
    currentHeadSha: "cccccccccccccccccccccccccccccccccccccccc",
  });

  assert.notEqual(
    notificationTransitionId(previous, "NEEDS_ANDRIS"),
    notificationTransitionId(current, "NEEDS_ANDRIS"),
  );
  assert.equal(evaluateNotificationTransition(previous, current).kind, "NEW_TRANSITION");
});

test("candidate fields are bounded and omit privileged/provider-specific source data", () => {
  const current = decision({
    workflowState: "NEEDS_ANDRIS",
    ci: "PASS",
    prTitle: `Title\u0000 with controls ${"x".repeat(220)}`,
    reason: `Reason\nwith\tcontrols ${"y".repeat(400)}`,
    allowedActions: ["OPEN_PR", "MERGE", "NEEDS_CHANGES"],
  });
  const candidate = notificationCandidateForDecision(current, "NEEDS_ANDRIS");
  const serialized = JSON.stringify(candidate);

  assert.ok(Array.from(candidate.title).length <= 160);
  assert.ok(Array.from(candidate.body).length <= 280);
  assert.doesNotMatch(candidate.title, /[\u0000-\u001f\u007f]/);
  assert.doesNotMatch(candidate.body, /[\u0000-\u001f\u007f]/);
  assert.doesNotMatch(serialized, /prUrl|allowedActions|expectedHeadSha|currentHeadSha|mainSha/);
  assert.doesNotMatch(serialized, /MERGE|NEEDS_CHANGES/);
  assert.match(candidate.transitionId, /^notification-v1-needs-andris-[0-9a-f]{16}$/);
});
