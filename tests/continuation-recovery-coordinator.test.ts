import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ContinuationRecoveryCoordinatorError,
  recoverAndCoordinateAuthoritativeContinuation,
  type ContinuationCampaignRecoveryReader,
} from "../src/integrations/cloudflare/continuation-recovery-coordinator.js";
import type {
  ContinuationCampaignRecoveryEvidence,
  ContinuationCampaignRecoveryIdentity,
} from "../src/integrations/cloudflare/d1-continuation-campaign-reader.js";
import type { ContinuationCoordinatorDependencies } from "../src/shared/continuation-coordinator.js";
import { ContinuationGithubSnapshotError } from "../src/shared/continuation-github-snapshot.js";
import type { IssueRead, PullRequestRead } from "../src/shared/source-control-read.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "1111111111111111111111111111111111111111";
const OTHER_SHA = "2222222222222222222222222222222222222222";
const OBSERVED_AT = "2026-08-21T12:00:00.000Z";

const identity: ContinuationCampaignRecoveryIdentity = {
  campaignId: CAMPAIGN_ID,
  projectId: PROJECT_ID,
  repository: REPOSITORY,
  expectedMainSha: MAIN_SHA,
};

function found(
  options: {
    nextTaskId?: string | null;
    humanGate?: "MERGE" | "DEPLOY" | "NEEDS_CHANGES" | "PRODUCTION_MUTATION" | null;
    tasks?: Array<{
      taskId: string;
      issueNumber: number;
      priority: number;
      activePullRequestNumber?: number | null;
      expectedHeadSha?: string | null;
    }>;
    expectedMainSha?: string;
  } = {},
): ContinuationCampaignRecoveryEvidence {
  const expectedMainSha = options.expectedMainSha ?? MAIN_SHA;
  return {
    kind: "FOUND",
    campaign: {
      schemaVersion: 1,
      campaignId: CAMPAIGN_ID,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      scope: "lidl",
      mode: "CONTINUE_ISSUES",
      continueEnabled: true,
      paused: false,
      expectedMainSha,
      currentTask: null,
      nextTaskId: options.nextTaskId ?? null,
      humanGate: options.humanGate ?? null,
      observedAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT,
    },
    tasks: (options.tasks ?? [
      { taskId: "task:517", issueNumber: 517, priority: 10 },
    ]).map((task) => ({
      taskId: task.taskId,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      issueNumber: task.issueNumber,
      taskState: "DISCOVERED" as const,
      activePullRequestNumber: task.activePullRequestNumber ?? null,
      expectedHeadSha: task.expectedHeadSha ?? null,
      priority: task.priority,
      updatedAt: OBSERVED_AT,
    })),
  };
}

class FakeReader implements ContinuationCampaignRecoveryReader {
  readonly calls: ContinuationCampaignRecoveryIdentity[] = [];
  readonly #evidence: ContinuationCampaignRecoveryEvidence;

  constructor(evidence: ContinuationCampaignRecoveryEvidence) {
    this.#evidence = evidence;
  }

  async read(input: ContinuationCampaignRecoveryIdentity): Promise<ContinuationCampaignRecoveryEvidence> {
    this.calls.push({ ...input });
    return this.#evidence;
  }
}

function issue(number: number): IssueRead {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    htmlUrl: `https://github.com/${REPOSITORY}/issues/${number}`,
  };
}

function pull(number: number, headSha = HEAD_SHA): PullRequestRead {
  return {
    number,
    title: `PR ${number}`,
    state: "open",
    draft: false,
    baseRef: "main",
    baseSha: MAIN_SHA,
    headRef: `feature-${number}`,
    headSha,
    changedFiles: 2,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${number}`,
  };
}

function dependencies(options: {
  issues?: IssueRead[];
  pulls?: PullRequestRead[];
} = {}): { value: ContinuationCoordinatorDependencies; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    value: {
      provider: {
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
      },
      now: () => OBSERVED_AT,
    },
  };
}

test("NOT_FOUND remains inert and never calls the GitHub provider", async () => {
  const reader = new FakeReader({ kind: "NOT_FOUND" });
  const deps = dependencies();

  assert.deepEqual(
    await recoverAndCoordinateAuthoritativeContinuation(reader, identity, deps.value),
    { kind: "NOT_FOUND" },
  );
  assert.deepEqual(reader.calls, [identity]);
  assert.deepEqual(deps.calls, []);
});

test("recovered owner gate returns before the first GitHub read", async () => {
  const reader = new FakeReader(found({ humanGate: "MERGE" }));
  const deps = dependencies();

  assert.deepEqual(
    await recoverAndCoordinateAuthoritativeContinuation(reader, identity, deps.value),
    { kind: "COORDINATED", plan: { kind: "HUMAN_GATE", gate: "MERGE" } },
  );
  assert.deepEqual(deps.calls, []);
});

test("fresh authoritative READY confirms the exact durable next task", async () => {
  const reader = new FakeReader(found({ nextTaskId: "task:517" }));
  const deps = dependencies({ issues: [issue(517)] });

  assert.deepEqual(
    await recoverAndCoordinateAuthoritativeContinuation(reader, identity, deps.value),
    {
      kind: "COORDINATED",
      plan: {
        kind: "READY",
        campaignId: CAMPAIGN_ID,
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        taskId: "task:517",
        issueNumber: 517,
        expectedMainSha: MAIN_SHA,
        observedAt: OBSERVED_AT,
      },
    },
  );
  assert.deepEqual(deps.calls, [
    `repository:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
    `issues:${REPOSITORY}`,
    `pulls:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
  ]);
});

test("durable next-task drift fails closed instead of selecting a different issue", async () => {
  const reader = new FakeReader(
    found({
      nextTaskId: "task:518",
      tasks: [
        { taskId: "task:517", issueNumber: 517, priority: 10 },
        { taskId: "task:518", issueNumber: 518, priority: 20 },
      ],
    }),
  );
  const deps = dependencies({ issues: [issue(517), issue(518)] });

  await assert.rejects(
    () => recoverAndCoordinateAuthoritativeContinuation(reader, identity, deps.value),
    (error: unknown) =>
      error instanceof ContinuationRecoveryCoordinatorError &&
      error.code === "NEXT_TASK_EVIDENCE_DRIFT",
  );
});

test("recovered expected PR head reaches the authoritative exact-head check unchanged", async () => {
  const reader = new FakeReader(
    found({
      nextTaskId: "task:518",
      tasks: [
        {
          taskId: "task:517",
          issueNumber: 517,
          priority: 10,
          activePullRequestNumber: 600,
          expectedHeadSha: HEAD_SHA,
        },
        { taskId: "task:518", issueNumber: 518, priority: 20 },
      ],
    }),
  );
  const deps = dependencies({
    issues: [issue(517), issue(518)],
    pulls: [pull(600, OTHER_SHA)],
  });

  await assert.rejects(
    () => recoverAndCoordinateAuthoritativeContinuation(reader, identity, deps.value),
    (error: unknown) =>
      error instanceof ContinuationGithubSnapshotError &&
      error.code === "EXPECTED_PULL_REQUEST_HEAD_DRIFT",
  );
});

test("recovery identity drift fails before the first GitHub provider call", async () => {
  const reader = new FakeReader(found({ expectedMainSha: OTHER_SHA }));
  const deps = dependencies();

  await assert.rejects(
    () => recoverAndCoordinateAuthoritativeContinuation(reader, identity, deps.value),
    (error: unknown) =>
      error instanceof ContinuationRecoveryCoordinatorError &&
      error.code === "RECOVERY_EVIDENCE_MISMATCH",
  );
  assert.deepEqual(deps.calls, []);
});

test("bridge stays detached and does not spread durable-only task metadata", () => {
  const source = readFileSync(
    resolve("src/integrations/cloudflare/continuation-recovery-coordinator.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /\b(?:fetch|send|enqueue|schedule|deploy|merge)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
  assert.doesNotMatch(source, /(?:CONTROL_NOTIFICATION_|CLOUDFLARE_|GITHUB_TOKEN)/u);
  assert.doesNotMatch(source, /\.\.\.task/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:worker|queue|notification)/u);
});
