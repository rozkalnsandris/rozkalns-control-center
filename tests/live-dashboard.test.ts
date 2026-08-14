import assert from "node:assert/strict";
import test from "node:test";

import { readLiveDashboardSnapshot } from "../src/shared/live-dashboard.js";
import { managedProjectPolicies } from "../src/shared/project-policy.js";
import type {
  CheckRunRead,
  PullRequestRead,
  PullRequestReviewRead,
  SourceControlReadProvider,
  WorkflowRunRead,
} from "../src/shared/source-control-read.js";

const OBSERVED_AT = "2026-08-14T18:10:00.000Z";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";

function pull(number: number, title: string): PullRequestRead {
  return {
    number,
    title,
    state: "open",
    draft: false,
    baseRef: "main",
    baseSha: MAIN_SHA,
    headRef: `feature-${number}`,
    headSha: HEAD_SHA,
    changedFiles: 3,
    htmlUrl: `https://github.com/rozkalnsandris/example/pull/${number}`,
  };
}

function check(conclusion: CheckRunRead["conclusion"]): CheckRunRead {
  return {
    id: "check-1",
    name: "CI",
    status: "completed",
    conclusion,
    headSha: HEAD_SHA,
    appId: 1,
    detailsUrl: null,
  };
}

function workflow(conclusion: string | null): WorkflowRunRead {
  return {
    id: "run-1",
    name: "CI",
    status: "completed",
    conclusion,
    headSha: HEAD_SHA,
    htmlUrl: "https://github.com/rozkalnsandris/example/actions/runs/1",
  };
}

function reviewsFor(repository: string): PullRequestReviewRead[] {
  if (repository.endsWith("/hermes-tech")) {
    return [{ id: "r1", state: "CHANGES_REQUESTED", actor: "reviewer", submittedAt: OBSERVED_AT }];
  }
  if (repository.endsWith("/rozkalns-cv")) {
    return [{ id: "r2", state: "APPROVED", actor: "reviewer", submittedAt: OBSERVED_AT }];
  }
  return [];
}

function pullsFor(repository: string): PullRequestRead[] {
  if (repository.endsWith("/hermes-tech")) return [pull(11, "Tech review change")];
  if (repository.endsWith("/hermes-deals")) return [pull(12, "Deals failing CI")];
  if (repository.endsWith("/rozkalns-cv")) return [pull(13, "CV passing observation")];
  return [];
}

function providerFor(repository: string, commitStatusReads: { value: number }): SourceControlReadProvider {
  return {
    async getRepository(requested) {
      assert.equal(requested, repository);
      return { repository, defaultBranch: "main" };
    },
    async getDefaultBranchHead(requested, branch) {
      assert.equal(requested, repository);
      assert.equal(branch, "main");
      return MAIN_SHA;
    },
    async listOpenIssues() {
      return [{ number: 101, title: "Open issue", state: "open", htmlUrl: "https://github.com/example/issue/101" }];
    },
    async listOpenPullRequests() {
      return pullsFor(repository);
    },
    async getPullRequest() {
      throw new Error("dashboard must reuse the listed pull-request observation");
    },
    async getPullRequestMergeState(_requested, pullNumber) {
      return {
        pullNumber,
        headSha: HEAD_SHA,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        draft: false,
      };
    },
    async listPullRequestReviews() {
      return reviewsFor(repository);
    },
    async listCheckRuns() {
      return [check(repository.endsWith("/hermes-deals") ? "failure" : "success")];
    },
    async listCommitStatuses() {
      commitStatusReads.value += 1;
      throw new Error("commit statuses are outside the approved Actions-stage dashboard scope");
    },
    async listWorkflowRuns() {
      return [workflow("success")];
    },
  };
}

test("live dashboard reads exactly the managed projects at one observation time and never invents merge readiness", async () => {
  const contextCalls: Array<{ repository: string; observedAt: string }> = [];
  const commitStatusReads = { value: 0 };

  const snapshot = await readLiveDashboardSnapshot(
    {
      createRepositoryReadContext(repository, observedAt) {
        contextCalls.push({ repository, observedAt });
        return { provider: providerFor(repository, commitStatusReads) };
      },
    },
    OBSERVED_AT,
  );

  assert.equal(snapshot.generatedAt, OBSERVED_AT);
  assert.deepEqual(
    contextCalls.map((item) => item.repository),
    managedProjectPolicies.map((policy) => policy.repository),
  );
  assert.equal(contextCalls.every((item) => item.observedAt === OBSERVED_AT), true);
  assert.equal(contextCalls.some((item) => item.repository === "rozkalnsandris/hermes-email-skill"), false);
  assert.equal(commitStatusReads.value, 0);
  assert.equal(snapshot.projects.length, 6);
  assert.equal(snapshot.projects.every((project) => project.openIssues === 1), true);

  const tech = snapshot.decisions.find((item) => item.projectId === "hermes-tech");
  const deals = snapshot.decisions.find((item) => item.projectId === "hermes-deals");
  const cv = snapshot.decisions.find((item) => item.projectId === "rozkalns-cv");
  assert.equal(tech?.workflowState, "NEEDS_ANDRIS");
  assert.equal(deals?.workflowState, "CI_FAILED");
  assert.equal(cv?.workflowState, "WAITING");
  assert.equal(cv?.ci, "PASS");
  assert.equal(cv?.review, "PENDING");
  assert.equal(snapshot.decisions.some((item) => item.workflowState === "MERGE_READY"), false);
  assert.equal(snapshot.decisions.every((item) => item.issueNumber === null && item.issueTitle === null), true);
  assert.equal(snapshot.decisions.every((item) => item.allowedActions.join(",") === "OPEN_PR"), true);
  assert.equal(snapshot.decisions.every((item) => item.lastReconciledAt === OBSERVED_AT), true);
});

test("live dashboard rejects exact-head evidence drift", async () => {
  const commitStatusReads = { value: 0 };
  const baseProvider = providerFor("rozkalnsandris/hermes-tech", commitStatusReads);
  const driftingProvider: SourceControlReadProvider = {
    ...baseProvider,
    async listCheckRuns() {
      return [{ ...check("success"), headSha: "3333333333333333333333333333333333333333" }];
    },
  };

  await assert.rejects(
    () => readLiveDashboardSnapshot(
      {
        createRepositoryReadContext(repository) {
          return { provider: repository === "rozkalnsandris/hermes-tech" ? driftingProvider : providerFor(repository, commitStatusReads) };
        },
      },
      OBSERVED_AT,
    ),
    /exact pull-request head/,
  );
});
