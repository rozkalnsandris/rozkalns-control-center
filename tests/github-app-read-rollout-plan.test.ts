import assert from "node:assert/strict";
import test from "node:test";

import { explicitlyExcludedRepositories } from "../src/shared/project-policy.js";
import {
  GITHUB_CONTROL_APP_NAME,
  GITHUB_CONTROL_READ_ROLLOUT_PLAN_VERSION,
  GITHUB_CONTROL_REPOSITORY_SELECTION,
  GitHubReadRolloutPlanError,
  assertPhase2GitHubReadRolloutPlanIntegrity,
  buildPhase2GitHubReadScopeForStage,
  getPhase2GitHubSelectedRepositories,
  phase2GitHubReadRolloutStages,
  type GitHubReadRolloutStageId,
} from "../src/integrations/github/app-read-rollout-plan.js";

const expectedRepositories = [
  "rozkalnsandris/hermes-tech",
  "rozkalnsandris/hermes-deals",
  "rozkalnsandris/rozkalns-cv",
  "rozkalnsandris/RPi5_main",
  "rozkalnsandris/ops-workflows",
  "rozkalnsandris/rozkalnsandris",
] as const;

const nonConditionalStages = [
  "metadata-rules",
  "contents",
  "issues",
  "pull-requests",
  "checks",
  "actions",
] as const satisfies readonly GitHubReadRolloutStageId[];

const cumulativePermissions = [
  ["metadata"],
  ["metadata", "contents"],
  ["metadata", "contents", "issues"],
  ["metadata", "contents", "issues", "pull_requests"],
  ["metadata", "contents", "issues", "pull_requests", "checks"],
  ["metadata", "contents", "issues", "pull_requests", "checks", "actions"],
] as const;

test("rollout identity and selected repositories are exact and policy-derived", () => {
  assert.equal(GITHUB_CONTROL_APP_NAME, "Rozkalns Control");
  assert.equal(GITHUB_CONTROL_REPOSITORY_SELECTION, "selected");
  assert.equal(GITHUB_CONTROL_READ_ROLLOUT_PLAN_VERSION, 1);
  assert.deepEqual(getPhase2GitHubSelectedRepositories(), expectedRepositories);

  const selected = new Set(getPhase2GitHubSelectedRepositories().map((repository) => repository.toLowerCase()));
  for (const excluded of explicitlyExcludedRepositories) {
    assert.equal(selected.has(excluded.toLowerCase()), false);
  }

  assert.doesNotThrow(() => assertPhase2GitHubReadRolloutPlanIntegrity());
});

test("first stage is metadata-only and plans repository plus active-rules canaries", () => {
  const first = phase2GitHubReadRolloutStages[0];
  assert.equal(first.id, "metadata-rules");
  assert.equal(first.addPermission, "metadata");
  assert.equal(first.evidenceGate, null);
  assert.deepEqual(
    first.canaries.map((canary) => [canary.id, canary.transport, canary.requiredPermission]),
    [
      ["repository-metadata", "REST", "metadata"],
      ["active-branch-rules", "REST", "metadata"],
    ],
  );

  const scope = buildPhase2GitHubReadScopeForStage(123, "metadata-rules");
  assert.deepEqual(scope.permissions, { metadata: "read" });
});

test("non-conditional rollout stages expand permissions monotonically and read-only", () => {
  let previous = new Set<string>();

  nonConditionalStages.forEach((stageId, index) => {
    const scope = buildPhase2GitHubReadScopeForStage(123, stageId);
    const current = new Set(Object.keys(scope.permissions));
    assert.deepEqual([...current], cumulativePermissions[index]);

    for (const permission of previous) assert.equal(current.has(permission), true);
    for (const access of Object.values(scope.permissions)) assert.equal(access, "read");
    previous = current;
  });
});

test("pull-request stage explicitly includes the future GraphQL merge-state permission canary", () => {
  const stage = phase2GitHubReadRolloutStages.find((candidate) => candidate.id === "pull-requests");
  assert.ok(stage);
  assert.deepEqual(
    stage.canaries.map((canary) => [canary.id, canary.transport]),
    [
      ["open-pull-requests", "REST"],
      ["pull-request-reviews", "REST"],
      ["pull-request-merge-state", "GRAPHQL"],
    ],
  );
  assert.equal(stage.canaries.every((canary) => canary.requiredPermission === "pull_requests"), true);
});

test("commit-status permission remains conditional on explicit repository evidence", () => {
  const statusStage = phase2GitHubReadRolloutStages.at(-1);
  assert.equal(statusStage?.id, "commit-statuses");
  assert.equal(statusStage?.addPermission, "statuses");
  assert.equal(statusStage?.evidenceGate, "LEGACY_COMMIT_STATUS_REQUIRED");

  assert.throws(
    () => buildPhase2GitHubReadScopeForStage(123, "commit-statuses"),
    (error) =>
      error instanceof GitHubReadRolloutPlanError &&
      error.message.includes("LEGACY_COMMIT_STATUS_REQUIRED"),
  );

  const scope = buildPhase2GitHubReadScopeForStage(123, "commit-statuses", {
    legacyCommitStatusRequired: true,
  });
  assert.deepEqual(Object.keys(scope.permissions), [
    "metadata",
    "contents",
    "issues",
    "pull_requests",
    "checks",
    "actions",
    "statuses",
  ]);
  assert.equal(scope.permissions.statuses, "read");
});

test("rollout plan cannot represent administration or write permission", () => {
  const serializedPlan = JSON.stringify(phase2GitHubReadRolloutStages);
  assert.equal(serializedPlan.includes("administration"), false);
  assert.equal(serializedPlan.includes('"write"'), false);
  assert.equal(serializedPlan.includes("hermes-email-skill"), false);
});

test("unknown rollout stages fail closed before a scope can be produced", () => {
  assert.throws(
    () => buildPhase2GitHubReadScopeForStage(123, "future-unknown-stage" as GitHubReadRolloutStageId),
    (error) => error instanceof GitHubReadRolloutPlanError && error.message.includes("Unknown GitHub App rollout stage"),
  );
});

test("scope builder delegates installation id validation to the existing read-scope contract", () => {
  assert.throws(
    () => buildPhase2GitHubReadScopeForStage(0, "metadata-rules"),
    /positive safe integer/,
  );
});
