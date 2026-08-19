import assert from "node:assert/strict";
import test from "node:test";

import { operatorAttentionForSummary } from "../src/react-app/operator-attention.js";

function summary(needsAndris: number, ciFailed: number) {
  return {
    needsAndris,
    ciFailed,
    workingOrWaiting: 0,
    mergeReady: 0,
    enabledProjects: 6,
  };
}

test("owner action outranks CI failure", () => {
  const attention = operatorAttentionForSummary(summary(2, 3));
  assert.equal(attention.tone, "attention");
  assert.equal(attention.target, "#needs-andris");
  assert.equal(attention.actionLabel, "Review owner actions");
  assert.match(attention.headline, /2 items need your decision/);
});

test("CI failure becomes the next signal when no owner action exists", () => {
  const attention = operatorAttentionForSummary(summary(0, 1));
  assert.equal(attention.tone, "danger");
  assert.equal(attention.target, "#ci-failed");
  assert.equal(attention.actionLabel, "Review CI failures");
  assert.match(attention.detail, /1 CI failure is blocking progress/);
});

test("all-clear snapshot has no navigation action", () => {
  const attention = operatorAttentionForSummary(summary(0, 0));
  assert.equal(attention.tone, "clear");
  assert.equal(attention.target, null);
  assert.equal(attention.actionLabel, null);
  assert.match(attention.detail, /no owner-action gate and no CI failure/);
});
