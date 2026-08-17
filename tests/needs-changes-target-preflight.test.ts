import assert from "node:assert/strict";
import test from "node:test";

import {
  NeedsChangesTargetPreflightError,
  preflightNeedsChangesTarget,
} from "../src/shared/needs-changes-target-preflight.js";
import type { SourceControlReadProvider } from "../src/shared/source-control-read.js";

const repository = "rozkalnsandris/ops-workflows";
const observedAt = "2026-08-17T18:10:00.000Z";
const headSha = "1111111111111111111111111111111111111111";
const mainSha = "2222222222222222222222222222222222222222";
const workflowRunId = "32048102560";

function provider(options: { issuePresent?: boolean; workflowConclusion?: string | null } = {}): SourceControlReadProvider {
  const issuePresent = options.issuePresent ?? true;
  const workflowConclusion = options.workflowConclusion ?? "success";
  return {
    async getRepository() {
      return { repository, defaultBranch: "main" };
    },
    async getDefaultBranchHead() {
      return mainSha;
    },
    async listOpenIssues() {
      return issuePresent
        ? [{ number: 47, title: "Canary tracking issue", state: "open" as const, htmlUrl: "https://github.com/example/issues/47" }]
        : [];
    },
    async listOpenPullRequests() {
      return [];
    },
    async getPullRequest(_repository, pullNumber) {
      return {
        number: pullNumber,
        title: "Disposable canary",
        state: "open" as const,
        draft: false,
        baseRef: "main",
        baseSha: mainSha,
        headRef: "test/canary",
        headSha,
        changedFiles: 1,
        htmlUrl: "https://github.com/example/pull/48",
      };
    },
    async getPullRequestMergeState(_repository, pullNumber) {
      return {
        pullNumber,
        headSha,
        mergeable: "MERGEABLE" as const,
        mergeStateStatus: "CLEAN" as const,
        draft: false,
      };
    },
    async listPullRequestReviews() {
      return [];
    },
    async listCheckRuns() {
      return [];
    },
    async listCommitStatuses() {
      throw new Error("commit statuses must not be requested by target preflight");
    },
    async listWorkflowRuns() {
      return [{
        id: workflowRunId,
        name: "Validate shared automation",
        status: "completed" as const,
        conclusion: workflowConclusion,
        headSha,
        htmlUrl: "https://github.com/example/actions/runs/32048102560",
      }];
    },
  };
}

function request(overrides: Partial<Parameters<typeof preflightNeedsChangesTarget>[1]> = {}) {
  return {
    repository,
    issueNumber: 47,
    pullNumber: 48,
    expectedHeadSha: headSha,
    expectedMainSha: mainSha,
    expectedWorkflowRunId: workflowRunId,
    observedAt,
    ...overrides,
  };
}

function preflightError(code: NeedsChangesTargetPreflightError["code"]) {
  return (error: unknown) => error instanceof NeedsChangesTargetPreflightError && error.code === code;
}

test("accepts only a genuine separate open issue plus exact ready PR head base and successful CI", async () => {
  const result = await preflightNeedsChangesTarget(provider(), request());
  assert.deepEqual(result, {
    repository,
    issueNumber: 47,
    pullNumber: 48,
    headSha,
    mainSha,
    workflowRunId,
    observedAt,
  });
});

test("rejects issueNumber equal to pullNumber before any provider read", async () => {
  let reads = 0;
  const base = provider();
  const counting = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        reads += 1;
        return value.apply(target, args);
      };
    },
  });

  await assert.rejects(
    () => preflightNeedsChangesTarget(counting, request({ issueNumber: 48 })),
    preflightError("ISSUE_PULL_IDENTITY_CONFLICT"),
  );
  assert.equal(reads, 0);
});

test("a PR-only identity cannot satisfy normalized issue evidence", async () => {
  await assert.rejects(
    () => preflightNeedsChangesTarget(provider({ issuePresent: false }), request()),
    preflightError("ISSUE_NOT_FOUND"),
  );
});

test("rejects stale head base and unsuccessful exact workflow evidence", async () => {
  await assert.rejects(
    () => preflightNeedsChangesTarget(provider(), request({ expectedHeadSha: "3333333333333333333333333333333333333333" })),
    preflightError("HEAD_MISMATCH"),
  );
  await assert.rejects(
    () => preflightNeedsChangesTarget(provider(), request({ expectedMainSha: "4444444444444444444444444444444444444444" })),
    preflightError("BASE_MISMATCH"),
  );
  await assert.rejects(
    () => preflightNeedsChangesTarget(provider({ workflowConclusion: "failure" }), request()),
    preflightError("CI_NOT_SUCCESSFUL"),
  );
});
