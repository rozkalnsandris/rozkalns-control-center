import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { ContinuationCoordinatorError } from "../src/shared/continuation-coordinator.js";
import { ContinuationGithubSnapshotError } from "../src/shared/continuation-github-snapshot.js";
import type {
  ContinuationHumanGate,
  ContinuationTaskState,
} from "../src/shared/continuation-plan.js";
import type { IssueRead, PullRequestRead } from "../src/shared/source-control-read.js";
import {
  ContinuationPostMergeReselectionError,
  reselectContinuationAfterMerge,
} from "../src/integrations/cloudflare/continuation-post-merge-reselection.js";
import type { ContinuationPostMergeTransitionProposal } from "../src/integrations/cloudflare/continuation-post-merge-transition.js";
import type { ContinuationCoordinatorDependencies } from "../src/shared/continuation-coordinator.js";

const CAMPAIGN_ID = "campaign:hermes-deals:lidl";
const PROJECT_ID = "hermes-deals";
const REPOSITORY = "rozkalnsandris/hermes-deals";
const MERGED_TASK_ID = "task:517";
const NEXT_TASK_ID = "task:518";
const PREVIOUS_MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const MERGE_SHA = "1111111111111111111111111111111111111111";
const EXPECTED_HEAD_SHA = "2222222222222222222222222222222222222222";
const DRIFT_SHA = "3333333333333333333333333333333333333333";
const TRANSITION_AT = "2026-08-21T16:00:55.000Z";
const POST_MERGE_AT = "2026-08-21T16:01:10.000Z";
const STALE_AT = "2026-08-21T16:00:54.000Z";

interface TaskFixture {
  readonly taskId: string;
  readonly issueNumber: number;
  readonly taskState: ContinuationTaskState;
  readonly activePullRequestNumber?: number | null;
  readonly expectedHeadSha?: string | null;
  readonly priority?: number;
  readonly updatedAt?: string;
}

function transition(
  options: {
    readonly nextTaskId?: string | null;
    readonly humanGate?: ContinuationHumanGate | null;
    readonly currentTaskState?: ContinuationTaskState;
    readonly expectedMainSha?: string;
    readonly campaignObservedAt?: string;
    readonly campaignUpdatedAt?: string;
    readonly tasks?: readonly TaskFixture[];
  } = {},
): ContinuationPostMergeTransitionProposal {
  const tasks = options.tasks ?? [
    {
      taskId: MERGED_TASK_ID,
      issueNumber: 517,
      taskState: "DONE" as const,
      priority: 10,
      updatedAt: TRANSITION_AT,
    },
    {
      taskId: NEXT_TASK_ID,
      issueNumber: 518,
      taskState: "DISCOVERED" as const,
      priority: 20,
      updatedAt: "2026-08-21T15:55:00.000Z",
    },
  ];

  return {
    schemaVersion: 1,
    kind: "POST_MERGE_TRANSITION",
    mergeEvidence: {
      merged: true,
      taskId: MERGED_TASK_ID,
      issueNumber: 517,
      pullRequestNumber: 600,
      expectedHeadSha: EXPECTED_HEAD_SHA,
      previousMainSha: PREVIOUS_MAIN_SHA,
      mergeSha: MERGE_SHA,
      observedAt: TRANSITION_AT,
    },
    campaign: {
      schemaVersion: 1,
      campaignId: CAMPAIGN_ID,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      scope: "lidl",
      mode: "CONTINUE_ISSUES",
      continueEnabled: true,
      paused: false,
      expectedMainSha: options.expectedMainSha ?? MERGE_SHA,
      currentTask: {
        taskId: MERGED_TASK_ID,
        state: options.currentTaskState ?? "DONE",
      },
      nextTaskId: options.nextTaskId ?? null,
      humanGate: options.humanGate ?? null,
      observedAt: options.campaignObservedAt ?? TRANSITION_AT,
      updatedAt: options.campaignUpdatedAt ?? TRANSITION_AT,
    },
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      issueNumber: task.issueNumber,
      taskState: task.taskState,
      activePullRequestNumber: task.activePullRequestNumber ?? null,
      expectedHeadSha: task.expectedHeadSha ?? null,
      priority: task.priority ?? 10,
      updatedAt: task.updatedAt ?? TRANSITION_AT,
    })),
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

function pull(number: number, headSha = EXPECTED_HEAD_SHA): PullRequestRead {
  return {
    number,
    title: `PR ${number}`,
    state: "open",
    draft: false,
    baseRef: "main",
    baseSha: MERGE_SHA,
    headRef: `feature-${number}`,
    headSha,
    changedFiles: 2,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${number}`,
  };
}

function dependencies(
  options: {
    readonly mainSha?: string;
    readonly issues?: IssueRead[];
    readonly pulls?: PullRequestRead[];
    readonly times?: string[];
  } = {},
): { readonly value: ContinuationCoordinatorDependencies; readonly calls: string[] } {
  const calls: string[] = [];
  const times = options.times ?? [POST_MERGE_AT, POST_MERGE_AT];
  let timeIndex = 0;

  const value: ContinuationCoordinatorDependencies = {
    provider: {
      async getRepository(repository) {
        calls.push(`repository:${repository}`);
        return { repository, defaultBranch: "main" };
      },
      async getDefaultBranchHead(repository, branch) {
        calls.push(`main:${repository}:${branch}`);
        return options.mainSha ?? MERGE_SHA;
      },
      async listOpenIssues(repository) {
        calls.push(`issues:${repository}`);
        return options.issues ?? [issue(518)];
      },
      async listOpenPullRequests(repository) {
        calls.push(`pulls:${repository}`);
        return options.pulls ?? [];
      },
    },
    now: () => {
      const observedAt = times[timeIndex] ?? times[times.length - 1];
      if (observedAt === undefined) throw new Error("test clock exhausted");
      timeIndex += 1;
      return observedAt;
    },
  };

  return { value, calls };
}

test("fresh post-merge re-selection excludes the completed closed task and selects the next open task", async () => {
  const deps = dependencies({ issues: [issue(518)] });

  assert.deepEqual(await reselectContinuationAfterMerge(transition(), deps.value), {
    kind: "READY",
    campaignId: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    taskId: NEXT_TASK_ID,
    issueNumber: 518,
    expectedMainSha: MERGE_SHA,
    observedAt: POST_MERGE_AT,
  });
  assert.deepEqual(deps.calls, [
    `repository:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
    `issues:${REPOSITORY}`,
    `pulls:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
  ]);
});

test("terminal-only post-merge evidence produces NO_ELIGIBLE_TASK without requiring the closed merged issue", async () => {
  const deps = dependencies({ issues: [], pulls: [] });
  const proposal = transition({
    tasks: [
      {
        taskId: MERGED_TASK_ID,
        issueNumber: 517,
        taskState: "DONE",
        priority: 10,
        updatedAt: TRANSITION_AT,
      },
    ],
  });

  assert.deepEqual(await reselectContinuationAfterMerge(proposal, deps.value), {
    kind: "NO_ELIGIBLE_TASK",
  });
});

test("post-merge main drift propagates the existing exact-main failure", async () => {
  const deps = dependencies({ mainSha: DRIFT_SHA, issues: [issue(518)] });

  await assert.rejects(
    () => reselectContinuationAfterMerge(transition(), deps.value),
    (error: unknown) =>
      error instanceof ContinuationCoordinatorError && error.code === "EXPECTED_MAIN_SHA_DRIFT",
  );
});

test("non-terminal expected PR head evidence still reaches the authoritative drift check", async () => {
  const proposal = transition({
    tasks: [
      {
        taskId: MERGED_TASK_ID,
        issueNumber: 517,
        taskState: "DONE",
        priority: 10,
        updatedAt: TRANSITION_AT,
      },
      {
        taskId: NEXT_TASK_ID,
        issueNumber: 518,
        taskState: "REVIEW",
        activePullRequestNumber: 601,
        expectedHeadSha: EXPECTED_HEAD_SHA,
        priority: 20,
        updatedAt: "2026-08-21T15:55:00.000Z",
      },
    ],
  });
  const deps = dependencies({ issues: [issue(518)], pulls: [pull(601, DRIFT_SHA)] });

  await assert.rejects(
    () => reselectContinuationAfterMerge(proposal, deps.value),
    (error: unknown) =>
      error instanceof ContinuationGithubSnapshotError &&
      error.code === "EXPECTED_PULL_REQUEST_HEAD_DRIFT",
  );
});

test("terminal task with retained PR/head evidence fails before GitHub reads", async () => {
  const proposal = transition({
    tasks: [
      {
        taskId: MERGED_TASK_ID,
        issueNumber: 517,
        taskState: "DONE",
        priority: 10,
        updatedAt: TRANSITION_AT,
      },
      {
        taskId: "task:519",
        issueNumber: 519,
        taskState: "CANCELLED",
        activePullRequestNumber: 602,
        expectedHeadSha: EXPECTED_HEAD_SHA,
        priority: 30,
        updatedAt: TRANSITION_AT,
      },
    ],
  });
  const deps = dependencies();

  await assert.rejects(
    () => reselectContinuationAfterMerge(proposal, deps.value),
    (error: unknown) =>
      error instanceof ContinuationPostMergeReselectionError &&
      error.code === "TERMINAL_TASK_EVIDENCE_MISMATCH",
  );
  assert.deepEqual(deps.calls, []);
});

test("a post-transition durable nextTaskId fails closed before GitHub reads", async () => {
  const deps = dependencies();

  await assert.rejects(
    () => reselectContinuationAfterMerge(transition({ nextTaskId: NEXT_TASK_ID }), deps.value),
    (error: unknown) =>
      error instanceof ContinuationPostMergeReselectionError &&
      error.code === "TRANSITION_EVIDENCE_MISMATCH",
  );
  assert.deepEqual(deps.calls, []);
});

test("the first injected observation cannot predate the verified merge transition", async () => {
  const deps = dependencies({ times: [STALE_AT] });

  await assert.rejects(
    () => reselectContinuationAfterMerge(transition(), deps.value),
    (error: unknown) =>
      error instanceof ContinuationPostMergeReselectionError &&
      error.code === "STALE_POST_MERGE_OBSERVATION",
  );
  assert.deepEqual(deps.calls, []);
});

test("the second injected observation is independently bounded by the merge transition", async () => {
  const deps = dependencies({ times: [POST_MERGE_AT, STALE_AT], issues: [issue(518)] });

  await assert.rejects(
    () => reselectContinuationAfterMerge(transition(), deps.value),
    (error: unknown) =>
      error instanceof ContinuationPostMergeReselectionError &&
      error.code === "STALE_POST_MERGE_OBSERVATION",
  );
  assert.deepEqual(deps.calls, [
    `repository:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
    `issues:${REPOSITORY}`,
    `pulls:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
  ]);
});

test("transition campaign identity and merge timestamp coherence fail closed before GitHub reads", async () => {
  const deps = dependencies();

  await assert.rejects(
    () =>
      reselectContinuationAfterMerge(
        transition({ campaignUpdatedAt: POST_MERGE_AT, expectedMainSha: DRIFT_SHA }),
        deps.value,
      ),
    (error: unknown) =>
      error instanceof ContinuationPostMergeReselectionError &&
      error.code === "TRANSITION_EVIDENCE_MISMATCH",
  );
  assert.deepEqual(deps.calls, []);
});

test("re-selection boundary stays detached, read-only and explicit about task field mapping", () => {
  const source = readFileSync(
    resolve("src/integrations/cloudflare/continuation-post-merge-reselection.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /\b(?:fetch|send|enqueue|schedule|deploy|persist|write)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
  assert.doesNotMatch(source, /(?:CONTROL_NOTIFICATION_|CLOUDFLARE_|GITHUB_TOKEN)/u);
  assert.doesNotMatch(source, /\.\.\.task/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:worker|queue|notification|d1-continuation-campaign-reader)/u);
});
