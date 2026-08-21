import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ContinuationPlanError,
  MAX_CONTINUATION_CANDIDATES,
  MAX_CONTINUATION_EVIDENCE_AGE_MS,
  planDeterministicContinuation,
  type ContinuationCampaignSnapshot,
  type ContinuationGithubSnapshot,
  type ContinuationHumanGate,
  type ContinuationTaskCandidate,
  type ContinuationTaskState,
} from "../src/shared/continuation-plan.js";

const REPOSITORY = "rozkalnsandris/hermes-deals";
const PROJECT_ID = "hermes-deals";
const MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const OBSERVED_AT = "2026-08-21T09:00:00.000Z";

function campaign(
  overrides: Partial<ContinuationCampaignSnapshot> = {},
): ContinuationCampaignSnapshot {
  return {
    schemaVersion: 1,
    campaignId: "campaign:hermes-deals:lidl",
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    continueEnabled: true,
    paused: false,
    currentTask: { taskId: "task:516", state: "DONE" },
    humanGate: null,
    ...overrides,
  };
}

function candidate(
  issueNumber: number,
  overrides: Partial<ContinuationTaskCandidate> = {},
): ContinuationTaskCandidate {
  return {
    taskId: `task:${issueNumber}`,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    issueNumber,
    issueState: "OPEN",
    taskState: "DISCOVERED",
    activePullRequestNumber: null,
    priority: 10,
    ...overrides,
  };
}

function evidence(
  candidates: readonly ContinuationTaskCandidate[] = [candidate(517)],
  overrides: Partial<ContinuationGithubSnapshot> = {},
): ContinuationGithubSnapshot {
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    mainSha: MAIN_SHA,
    observedAt: OBSERVED_AT,
    candidates,
    ...overrides,
  };
}

function expectError(action: () => unknown, code: ContinuationPlanError["code"]): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof ContinuationPlanError && error.code === code,
  );
}

test("fresh exact-repository evidence selects one next eligible issue", () => {
  assert.deepEqual(planDeterministicContinuation(campaign(), evidence(), OBSERVED_AT), {
    kind: "READY",
    campaignId: "campaign:hermes-deals:lidl",
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    taskId: "task:517",
    issueNumber: 517,
    expectedMainSha: MAIN_SHA,
    observedAt: OBSERVED_AT,
  });
});

test("priority then issue number is deterministic regardless of input ordering", () => {
  const candidates = [
    candidate(520, { priority: 1 }),
    candidate(518, { priority: 1 }),
    candidate(517, { priority: 2 }),
  ];

  for (const ordered of [candidates, [...candidates].reverse()]) {
    const result = planDeterministicContinuation(campaign(), evidence(ordered), OBSERVED_AT);
    assert.equal(result.kind, "READY");
    if (result.kind === "READY") assert.equal(result.issueNumber, 518);
  }
});

test("explicit owner gates outrank pause and never become continuation permission", () => {
  const gates: ContinuationHumanGate[] = [
    "MERGE",
    "DEPLOY",
    "NEEDS_CHANGES",
    "PRODUCTION_MUTATION",
  ];

  for (const gate of gates) {
    assert.deepEqual(
      planDeterministicContinuation(
        campaign({ humanGate: gate, paused: true, continueEnabled: false }),
        evidence(),
        OBSERVED_AT,
      ),
      { kind: "HUMAN_GATE", gate },
    );
  }
});

test("pause and disabled continuation both fail closed without selecting a task", () => {
  assert.deepEqual(
    planDeterministicContinuation(campaign({ paused: true }), evidence(), OBSERVED_AT),
    { kind: "PAUSED" },
  );
  assert.deepEqual(
    planDeterministicContinuation(
      campaign({ continueEnabled: false }),
      evidence(),
      OBSERVED_AT,
    ),
    { kind: "CONTINUATION_DISABLED" },
  );
});

test("only a completed current task permits next-task selection", () => {
  const blockedStates: ContinuationTaskState[] = [
    "READY",
    "WORKING",
    "WAIT_CI",
    "NEEDS_ANDRIS",
    "MERGE_READY",
    "MERGED",
    "DEPLOY_DECISION",
    "PRODUCTION_VERIFY",
    "CI_FAILED",
  ];

  for (const state of blockedStates) {
    assert.deepEqual(
      planDeterministicContinuation(
        campaign({ currentTask: { taskId: "task:516", state } }),
        evidence(),
        OBSERVED_AT,
      ),
      { kind: "CURRENT_TASK_INCOMPLETE", state },
    );
  }

  assert.equal(
    planDeterministicContinuation(campaign({ currentTask: null }), evidence(), OBSERVED_AT).kind,
    "READY",
  );
});

test("closed issues, active pull requests and ineligible task states are never selected", () => {
  const candidates = [
    candidate(517, { issueState: "CLOSED" }),
    candidate(518, { activePullRequestNumber: 519 }),
    candidate(520, { taskState: "WORKING" }),
    candidate(521, { taskState: "CI_FAILED" }),
  ];

  assert.deepEqual(planDeterministicContinuation(campaign(), evidence(candidates), OBSERVED_AT), {
    kind: "NO_ELIGIBLE_TASK",
  });
});

test("the completed current task cannot be selected again", () => {
  assert.deepEqual(
    planDeterministicContinuation(campaign(), evidence([candidate(516)]), OBSERVED_AT),
    { kind: "NO_ELIGIBLE_TASK" },
  );
});

test("GitHub evidence older than 60 seconds or from the future is rejected", () => {
  const withinWindow = new Date(Date.parse(OBSERVED_AT) + MAX_CONTINUATION_EVIDENCE_AGE_MS);
  assert.equal(
    planDeterministicContinuation(campaign(), evidence(), withinWindow.toISOString()).kind,
    "READY",
  );

  const stale = new Date(withinWindow.getTime() + 1);
  expectError(
    () => planDeterministicContinuation(campaign(), evidence(), stale.toISOString()),
    "STALE_GITHUB_EVIDENCE",
  );
  expectError(
    () =>
      planDeterministicContinuation(
        campaign(),
        evidence([], { observedAt: "2026-08-21T09:00:00.001Z" }),
        OBSERVED_AT,
      ),
    "STALE_GITHUB_EVIDENCE",
  );
});

test("timestamps and main SHA must be canonical exact evidence", () => {
  expectError(
    () =>
      planDeterministicContinuation(
        campaign(),
        evidence([], { observedAt: "2026-08-21T09:00:00Z" }),
        OBSERVED_AT,
      ),
    "INVALID_INPUT",
  );
  expectError(
    () => planDeterministicContinuation(campaign(), evidence([], { mainSha: "MAIN" }), OBSERVED_AT),
    "INVALID_INPUT",
  );
});

test("excluded, unknown, cross-project and cross-repository evidence fails closed", () => {
  for (const repository of ["rozkalnsandris/hermes-email-skill", "rozkalnsandris/not-managed"]) {
    expectError(
      () =>
        planDeterministicContinuation(
          campaign({ repository }),
          evidence([], { repository }),
          OBSERVED_AT,
        ),
      "REPOSITORY_NOT_ALLOWED",
    );
  }

  expectError(
    () =>
      planDeterministicContinuation(
        campaign({ projectId: "hermes-tech" }),
        evidence(),
        OBSERVED_AT,
      ),
    "REPOSITORY_EVIDENCE_MISMATCH",
  );
  expectError(
    () =>
      planDeterministicContinuation(
        campaign(),
        evidence([], { repository: "rozkalnsandris/hermes-tech" }),
        OBSERVED_AT,
      ),
    "REPOSITORY_EVIDENCE_MISMATCH",
  );
  expectError(
    () =>
      planDeterministicContinuation(
        campaign(),
        evidence([candidate(517, { projectId: "hermes-tech" })]),
        OBSERVED_AT,
      ),
    "REPOSITORY_EVIDENCE_MISMATCH",
  );
});

test("duplicate task identity or issue identity is rejected before selection", () => {
  expectError(
    () =>
      planDeterministicContinuation(
        campaign(),
        evidence([candidate(517), candidate(518, { taskId: "task:517" })]),
        OBSERVED_AT,
      ),
    "DUPLICATE_CANDIDATE",
  );
  expectError(
    () =>
      planDeterministicContinuation(
        campaign(),
        evidence([candidate(517), candidate(517, { taskId: "task:different" })]),
        OBSERVED_AT,
      ),
    "DUPLICATE_CANDIDATE",
  );
});

test("candidate set is finite, bounded and fully validated before owner gates", () => {
  const excessive = Array.from({ length: MAX_CONTINUATION_CANDIDATES + 1 }, (_, index) =>
    candidate(index + 1),
  );
  expectError(
    () => planDeterministicContinuation(campaign(), evidence(excessive), OBSERVED_AT),
    "TOO_MANY_CANDIDATES",
  );
  expectError(
    () =>
      planDeterministicContinuation(
        campaign({ humanGate: "MERGE" }),
        evidence([candidate(517, { priority: -1 })]),
        OBSERVED_AT,
      ),
    "INVALID_INPUT",
  );
});

test("unknown gates, invalid task state and malformed identifiers fail closed", () => {
  expectError(
    () =>
      planDeterministicContinuation(
        campaign({ humanGate: "AUTO_MERGE" as ContinuationHumanGate }),
        evidence(),
        OBSERVED_AT,
      ),
    "INVALID_INPUT",
  );
  expectError(
    () =>
      planDeterministicContinuation(
        campaign(),
        evidence([candidate(517, { taskState: "AUTO_DEPLOY" as ContinuationTaskState })]),
        OBSERVED_AT,
      ),
    "INVALID_INPUT",
  );
  expectError(
    () =>
      planDeterministicContinuation(
        campaign({ campaignId: "../unsafe" }),
        evidence(),
        OBSERVED_AT,
      ),
    "INVALID_INPUT",
  );
});

test("planning remains detached from runtime, providers and mutation boundaries", () => {
  const source = readFileSync(resolve("src/shared/continuation-plan.ts"), "utf8");

  assert.doesNotMatch(source, /\b(?:fetch|send|enqueue|schedule|deploy|merge)\s*\(/u);
  assert.doesNotMatch(source, /(?:CONTROL_NOTIFICATION_|CLOUDFLARE_|GITHUB_TOKEN)/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:worker|integrations|queue|notification)/u);
});
