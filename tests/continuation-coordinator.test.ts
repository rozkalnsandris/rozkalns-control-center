import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ContinuationCoordinatorError,
  coordinateAuthoritativeContinuation,
  type ContinuationCoordinatorDependencies,
} from "../src/shared/continuation-coordinator.js";
import {
  ContinuationGithubSnapshotError,
  type ContinuationGithubReadProvider,
  type ContinuationTaskBinding,
} from "../src/shared/continuation-github-snapshot.js";
import {
  ContinuationPlanError,
  MAX_CONTINUATION_CANDIDATES,
  type ContinuationCampaignSnapshot,
  type ContinuationHumanGate,
} from "../src/shared/continuation-plan.js";
import type { IssueRead, PullRequestRead } from "../src/shared/source-control-read.js";

const REPOSITORY = "rozkalnsandris/hermes-deals";
const PROJECT_ID = "hermes-deals";
const MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "2222222222222222222222222222222222222222";
const OBSERVED_AT = "2026-08-21T11:00:00.000Z";

function campaign(
  overrides: Partial<ContinuationCampaignSnapshot> = {},
): ContinuationCampaignSnapshot {
  return {
    schemaVersion: 1,
    campaignId: "campaign:deals:lidl",
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    continueEnabled: true,
    paused: false,
    currentTask: { taskId: "task:516", state: "DONE" },
    humanGate: null,
    ...overrides,
  };
}

function binding(
  number: number,
  overrides: Partial<ContinuationTaskBinding> = {},
): ContinuationTaskBinding {
  return {
    taskId: `task:${number}`,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    issueNumber: number,
    taskState: "DISCOVERED",
    activePullRequestNumber: null,
    priority: 10,
    ...overrides,
  };
}

function issue(number: number): IssueRead {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    htmlUrl: `https://github.com/${REPOSITORY}/issues/${number}`,
  };
}

function pull(number: number): PullRequestRead {
  return {
    number,
    title: `PR ${number}`,
    state: "open",
    draft: false,
    baseRef: "main",
    baseSha: MAIN_SHA,
    headRef: `feature-${number}`,
    headSha: "1111111111111111111111111111111111111111",
    changedFiles: 2,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${number}`,
  };
}

function dependencies(options: {
  issues?: IssueRead[];
  pulls?: PullRequestRead[];
  clock?: string[];
  provider?: Partial<ContinuationGithubReadProvider>;
} = {}): { value: ContinuationCoordinatorDependencies; calls: string[]; clockCalls: string[] } {
  const calls: string[] = [];
  const clockCalls: string[] = [];
  const values = options.clock ?? [OBSERVED_AT, OBSERVED_AT];
  let index = 0;
  const provider: ContinuationGithubReadProvider = {
    async getRepository(repository) {
      calls.push(`repository:${repository}`);
      return { repository, defaultBranch: "main" };
    },
    async getDefaultBranchHead(repository, branch) {
      calls.push(`main:${repository}:${branch}`);
      return MAIN_SHA;
    },
    async listOpenIssues(repository) {
      calls.push(`issues:${repository}`);
      return options.issues ?? [issue(517)];
    },
    async listOpenPullRequests(repository) {
      calls.push(`pulls:${repository}`);
      return options.pulls ?? [];
    },
    ...options.provider,
  };

  return {
    calls,
    clockCalls,
    value: {
      provider,
      now() {
        const value = values[Math.min(index, values.length - 1)] ?? OBSERVED_AT;
        index += 1;
        clockCalls.push(value);
        return value;
      },
    },
  };
}

test("one authoritative observation produces an exact-main deterministic plan", async () => {
  const deps = dependencies();
  const result = await coordinateAuthoritativeContinuation(
    campaign(),
    [binding(517)],
    MAIN_SHA,
    deps.value,
  );

  assert.deepEqual(result, {
    kind: "READY",
    campaignId: "campaign:deals:lidl",
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    taskId: "task:517",
    issueNumber: 517,
    expectedMainSha: MAIN_SHA,
    observedAt: OBSERVED_AT,
  });
  assert.deepEqual(deps.calls, [
    `repository:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
    `issues:${REPOSITORY}`,
    `pulls:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
  ]);
  assert.equal(deps.clockCalls.length, 2);
});

test("every explicit owner gate returns before the first GitHub provider read", async () => {
  const gates: ContinuationHumanGate[] = [
    "MERGE",
    "DEPLOY",
    "NEEDS_CHANGES",
    "PRODUCTION_MUTATION",
  ];

  for (const gate of gates) {
    const deps = dependencies();
    assert.deepEqual(
      await coordinateAuthoritativeContinuation(
        campaign({ humanGate: gate, paused: true }),
        [binding(517)],
        MAIN_SHA,
        deps.value,
      ),
      { kind: "HUMAN_GATE", gate },
    );
    assert.deepEqual(deps.calls, []);
    assert.equal(deps.clockCalls.length, 1);
  }
});

test("paused, disabled and unfinished campaigns never call the GitHub provider", async () => {
  const examples: Array<{
    snapshot: ContinuationCampaignSnapshot;
    expected: { kind: string; state?: string };
  }> = [
    { snapshot: campaign({ paused: true }), expected: { kind: "PAUSED" } },
    {
      snapshot: campaign({ continueEnabled: false }),
      expected: { kind: "CONTINUATION_DISABLED" },
    },
    {
      snapshot: campaign({ currentTask: { taskId: "task:516", state: "MERGED" } }),
      expected: { kind: "CURRENT_TASK_INCOMPLETE", state: "MERGED" },
    },
    {
      snapshot: campaign({ currentTask: { taskId: "task:516", state: "DEPLOY_DECISION" } }),
      expected: { kind: "CURRENT_TASK_INCOMPLETE", state: "DEPLOY_DECISION" },
    },
  ];

  for (const example of examples) {
    const deps = dependencies();
    assert.deepEqual(
      await coordinateAuthoritativeContinuation(
        example.snapshot,
        [binding(517)],
        MAIN_SHA,
        deps.value,
      ),
      example.expected,
    );
    assert.deepEqual(deps.calls, []);
  }
});

test("malformed expected main or observation time fails before the first provider call", async () => {
  const invalidMain = dependencies();
  await assert.rejects(
    () =>
      coordinateAuthoritativeContinuation(
        campaign(),
        [binding(517)],
        "main",
        invalidMain.value,
      ),
    (error: unknown) => error instanceof ContinuationPlanError && error.code === "INVALID_INPUT",
  );
  assert.deepEqual(invalidMain.calls, []);

  const invalidTime = dependencies({ clock: ["2026-08-21T11:00:00Z"] });
  await assert.rejects(
    () =>
      coordinateAuthoritativeContinuation(
        campaign(),
        [binding(517)],
        MAIN_SHA,
        invalidTime.value,
      ),
    (error: unknown) => error instanceof ContinuationPlanError && error.code === "INVALID_INPUT",
  );
  assert.deepEqual(invalidTime.calls, []);
});

test("unknown campaign project and unbounded bindings fail before provider interaction", async () => {
  const wrongProject = dependencies();
  await assert.rejects(
    () =>
      coordinateAuthoritativeContinuation(
        campaign({ projectId: "hermes-tech" }),
        [binding(517)],
        MAIN_SHA,
        wrongProject.value,
      ),
    (error: unknown) =>
      error instanceof ContinuationPlanError && error.code === "REPOSITORY_EVIDENCE_MISMATCH",
  );
  assert.deepEqual(wrongProject.calls, []);

  const oversized = dependencies();
  const bindings = Array.from({ length: MAX_CONTINUATION_CANDIDATES + 1 }, (_, index) =>
    binding(index + 1),
  );
  await assert.rejects(
    () => coordinateAuthoritativeContinuation(campaign(), bindings, MAIN_SHA, oversized.value),
    (error: unknown) =>
      error instanceof ContinuationCoordinatorError && error.code === "INVALID_INPUT",
  );
  assert.deepEqual(oversized.calls, []);
});

test("stable observed main differing from expected baseline is never planning permission", async () => {
  const deps = dependencies({
    provider: {
      async getDefaultBranchHead() {
        return OTHER_SHA;
      },
    },
  });

  await assert.rejects(
    () => coordinateAuthoritativeContinuation(campaign(), [binding(517)], MAIN_SHA, deps.value),
    (error: unknown) =>
      error instanceof ContinuationCoordinatorError && error.code === "EXPECTED_MAIN_SHA_DRIFT",
  );
});

test("main drift during the read-only snapshot preserves the lower-layer race guard", async () => {
  let reads = 0;
  const deps = dependencies({
    provider: {
      async getDefaultBranchHead() {
        reads += 1;
        return reads === 1 ? MAIN_SHA : OTHER_SHA;
      },
    },
  });

  await assert.rejects(
    () => coordinateAuthoritativeContinuation(campaign(), [binding(517)], MAIN_SHA, deps.value),
    (error: unknown) =>
      error instanceof ContinuationGithubSnapshotError && error.code === "MAIN_SHA_DRIFT",
  );
  assert.equal(reads, 2);
});

test("evidence expiring during provider observation fails closed at the final clock gate", async () => {
  const deps = dependencies({ clock: [OBSERVED_AT, "2026-08-21T11:01:00.001Z"] });

  await assert.rejects(
    () => coordinateAuthoritativeContinuation(campaign(), [binding(517)], MAIN_SHA, deps.value),
    (error: unknown) =>
      error instanceof ContinuationPlanError && error.code === "STALE_GITHUB_EVIDENCE",
  );
  assert.equal(deps.clockCalls.length, 2);
});

test("caller-owned campaign and bindings are sealed before asynchronous provider reads", async () => {
  const mutableCampaign = campaign();
  const mutableBinding = binding(517);
  const deps = dependencies({
    provider: {
      async getRepository(repository) {
        Object.assign(mutableCampaign, {
          repository: "rozkalnsandris/hermes-tech",
          projectId: "hermes-tech",
          humanGate: "DEPLOY",
        });
        Object.assign(mutableBinding, {
          repository: "rozkalnsandris/hermes-tech",
          projectId: "hermes-tech",
          issueNumber: 999,
          priority: -1,
        });
        return { repository, defaultBranch: "main" };
      },
    },
  });

  const result = await coordinateAuthoritativeContinuation(
    mutableCampaign,
    [mutableBinding],
    MAIN_SHA,
    deps.value,
  );
  assert.equal(result.kind, "READY");
  if (result.kind === "READY") {
    assert.equal(result.repository, REPOSITORY);
    assert.equal(result.issueNumber, 517);
  }
});

test("unattributed active PRs are never silently converted into next-task eligibility", async () => {
  const deps = dependencies({ pulls: [pull(600)] });

  await assert.rejects(
    () => coordinateAuthoritativeContinuation(campaign(), [binding(517)], MAIN_SHA, deps.value),
    (error: unknown) =>
      error instanceof ContinuationGithubSnapshotError &&
      error.code === "UNATTRIBUTED_OPEN_PULL_REQUEST",
  );
});

test("exact task-to-PR attribution keeps existing PR tasks ineligible", async () => {
  const deps = dependencies({ issues: [issue(517), issue(518)], pulls: [pull(600)] });
  const result = await coordinateAuthoritativeContinuation(
    campaign(),
    [binding(517, { activePullRequestNumber: 600 }), binding(518)],
    MAIN_SHA,
    deps.value,
  );

  assert.equal(result.kind, "READY");
  if (result.kind === "READY") assert.equal(result.issueNumber, 518);
});

test("no eligible issue remains evidence only after one read-only observation", async () => {
  const deps = dependencies({ issues: [], pulls: [] });

  assert.deepEqual(
    await coordinateAuthoritativeContinuation(campaign(), [], MAIN_SHA, deps.value),
    { kind: "NO_ELIGIBLE_TASK" },
  );
  assert.equal(deps.calls.length, 5);
});

test("coordinator stays detached from runtime, notification and mutation boundaries", () => {
  const source = readFileSync(resolve("src/shared/continuation-coordinator.ts"), "utf8");

  assert.doesNotMatch(source, /\b(?:fetch|send|enqueue|schedule|deploy|merge)\s*\(/u);
  assert.doesNotMatch(source, /(?:CONTROL_NOTIFICATION_|CLOUDFLARE_|GITHUB_TOKEN)/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:worker|integrations|queue|notification)/u);
});
