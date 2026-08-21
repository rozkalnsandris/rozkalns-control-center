import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ContinuationGithubSnapshotError,
  MAX_CONTINUATION_PROVIDER_RECORDS,
  readContinuationGithubSnapshot,
  type ContinuationGithubReadProvider,
  type ContinuationTaskBinding,
} from "../src/shared/continuation-github-snapshot.js";
import {
  MAX_CONTINUATION_CANDIDATES,
  planDeterministicContinuation,
  type ContinuationCampaignSnapshot,
} from "../src/shared/continuation-plan.js";
import type { IssueRead, PullRequestRead } from "../src/shared/source-control-read.js";

const REPOSITORY = "rozkalnsandris/hermes-deals";
const PROJECT_ID = "hermes-deals";
const MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const OBSERVED_AT = "2026-08-21T10:00:00.000Z";

function task(number: number, overrides: Partial<ContinuationTaskBinding> = {}): ContinuationTaskBinding {
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

function issue(number: number, overrides: Partial<IssueRead> = {}): IssueRead {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    htmlUrl: `https://github.com/${REPOSITORY}/issues/${number}`,
    ...overrides,
  };
}

function pull(number: number, overrides: Partial<PullRequestRead> = {}): PullRequestRead {
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
    ...overrides,
  };
}

function fakeProvider(
  issues: IssueRead[] = [issue(517)],
  pulls: PullRequestRead[] = [],
  overrides: Partial<ContinuationGithubReadProvider> = {},
): { provider: ContinuationGithubReadProvider; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
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
        return issues;
      },
      async listOpenPullRequests(repository) {
        calls.push(`pulls:${repository}`);
        return pulls;
      },
      ...overrides,
    },
  };
}

async function expectError(
  action: () => Promise<unknown>,
  code: ContinuationGithubSnapshotError["code"],
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof ContinuationGithubSnapshotError && error.code === code,
  );
}

test("authoritative read-only snapshot rechecks exact main around issue and PR observation", async () => {
  const { provider, calls } = fakeProvider();
  const snapshot = await readContinuationGithubSnapshot(
    provider,
    REPOSITORY,
    PROJECT_ID,
    [task(517)],
    OBSERVED_AT,
  );

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    repository: REPOSITORY,
    mainSha: MAIN_SHA,
    observedAt: OBSERVED_AT,
    candidates: [{ ...task(517), issueState: "OPEN" }],
  });
  assert.deepEqual(calls, [
    `repository:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
    `issues:${REPOSITORY}`,
    `pulls:${REPOSITORY}`,
    `main:${REPOSITORY}:main`,
  ]);
});

test("snapshot composes with detached planner without weakening owner gates", async () => {
  const { provider } = fakeProvider([issue(517), issue(518)], [pull(600)]);
  const snapshot = await readContinuationGithubSnapshot(
    provider,
    REPOSITORY,
    PROJECT_ID,
    [task(517, { activePullRequestNumber: 600 }), task(518)],
    OBSERVED_AT,
  );
  const campaign: ContinuationCampaignSnapshot = {
    schemaVersion: 1,
    campaignId: "campaign:deals",
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    continueEnabled: true,
    paused: false,
    currentTask: null,
    humanGate: null,
  };

  const result = planDeterministicContinuation(campaign, snapshot, OBSERVED_AT);
  assert.equal(result.kind, "READY");
  if (result.kind === "READY") assert.equal(result.issueNumber, 518);

  assert.deepEqual(
    planDeterministicContinuation({ ...campaign, humanGate: "MERGE" }, snapshot, OBSERVED_AT),
    { kind: "HUMAN_GATE", gate: "MERGE" },
  );
});

test("excluded projects, cross-project bindings and malformed input never call GitHub", async () => {
  const { provider, calls } = fakeProvider();
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        provider,
        "rozkalnsandris/hermes-email-skill",
        PROJECT_ID,
        [],
        OBSERVED_AT,
      ),
    "REPOSITORY_NOT_ALLOWED",
  );
  await expectError(
    () => readContinuationGithubSnapshot(provider, REPOSITORY, "hermes-tech", [], OBSERVED_AT),
    "REPOSITORY_EVIDENCE_MISMATCH",
  );
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        provider,
        REPOSITORY,
        PROJECT_ID,
        [task(517, { priority: -1 })],
        OBSERVED_AT,
      ),
    "INVALID_INPUT",
  );
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        provider,
        REPOSITORY,
        PROJECT_ID,
        [task(517)],
        "2026-08-21T10:00:00Z",
      ),
    "INVALID_INPUT",
  );
  assert.deepEqual(calls, []);
});

test("duplicate task, issue or PR bindings fail before the first read", async () => {
  const { provider, calls } = fakeProvider();
  for (const bindings of [
    [task(517), task(518, { taskId: "task:517" })],
    [task(517), task(517, { taskId: "task:other" })],
    [task(517, { activePullRequestNumber: 600 }), task(518, { activePullRequestNumber: 600 })],
  ]) {
    await expectError(
      () => readContinuationGithubSnapshot(provider, REPOSITORY, PROJECT_ID, bindings, OBSERVED_AT),
      "DUPLICATE_EVIDENCE",
    );
  }
  assert.deepEqual(calls, []);
});

test("candidate input is bounded before provider interaction", async () => {
  const { provider, calls } = fakeProvider();
  const bindings = Array.from({ length: MAX_CONTINUATION_CANDIDATES + 1 }, (_, index) =>
    task(index + 1),
  );
  await expectError(
    () => readContinuationGithubSnapshot(provider, REPOSITORY, PROJECT_ID, bindings, OBSERVED_AT),
    "TOO_MANY_RECORDS",
  );
  assert.deepEqual(calls, []);
});

test("repository identity drift and malformed main evidence fail closed", async () => {
  const wrongRepository = fakeProvider([], [], {
    async getRepository() {
      return { repository: "rozkalnsandris/hermes-tech", defaultBranch: "main" };
    },
  });
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        wrongRepository.provider,
        REPOSITORY,
        PROJECT_ID,
        [],
        OBSERVED_AT,
      ),
    "REPOSITORY_EVIDENCE_MISMATCH",
  );

  const malformed = fakeProvider([], [], {
    async getDefaultBranchHead() {
      return "main";
    },
  });
  await expectError(
    () =>
      readContinuationGithubSnapshot(malformed.provider, REPOSITORY, PROJECT_ID, [], OBSERVED_AT),
    "INVALID_INPUT",
  );
});

test("default-branch main race is rejected", async () => {
  let reads = 0;
  const { provider } = fakeProvider([issue(517)], [], {
    async getDefaultBranchHead() {
      reads += 1;
      return reads === 1 ? MAIN_SHA : "2222222222222222222222222222222222222222";
    },
  });

  await expectError(
    () =>
      readContinuationGithubSnapshot(provider, REPOSITORY, PROJECT_ID, [task(517)], OBSERVED_AT),
    "MAIN_SHA_DRIFT",
  );
  assert.equal(reads, 2);
});

test("unobserved or closed issues never become invented continuation candidates", async () => {
  const missing = fakeProvider([]);
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        missing.provider,
        REPOSITORY,
        PROJECT_ID,
        [task(517)],
        OBSERVED_AT,
      ),
    "ISSUE_EVIDENCE_MISSING",
  );

  const closed = fakeProvider([issue(517, { state: "closed" })]);
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        closed.provider,
        REPOSITORY,
        PROJECT_ID,
        [task(517)],
        OBSERVED_AT,
      ),
    "UNSUPPORTED_ISSUE_EVIDENCE",
  );
});

test("unattributed open PRs and stale explicit PR bindings fail closed", async () => {
  const unattributed = fakeProvider([issue(517)], [pull(600)]);
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        unattributed.provider,
        REPOSITORY,
        PROJECT_ID,
        [task(517)],
        OBSERVED_AT,
      ),
    "UNATTRIBUTED_OPEN_PULL_REQUEST",
  );

  const missing = fakeProvider([issue(517)]);
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        missing.provider,
        REPOSITORY,
        PROJECT_ID,
        [task(517, { activePullRequestNumber: 600 })],
        OBSERVED_AT,
      ),
    "PULL_REQUEST_EVIDENCE_MISSING",
  );
});

test("cross-repository issue or PR URLs and duplicate observations are rejected", async () => {
  const wrongIssue = fakeProvider([
    issue(517, { htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/issues/517" }),
  ]);
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        wrongIssue.provider,
        REPOSITORY,
        PROJECT_ID,
        [task(517)],
        OBSERVED_AT,
      ),
    "REPOSITORY_EVIDENCE_MISMATCH",
  );

  const duplicate = fakeProvider([issue(517), issue(517)]);
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        duplicate.provider,
        REPOSITORY,
        PROJECT_ID,
        [task(517)],
        OBSERVED_AT,
      ),
    "DUPLICATE_EVIDENCE",
  );

  const wrongPull = fakeProvider(
    [issue(517)],
    [pull(600, { htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/pull/600" })],
  );
  await expectError(
    () =>
      readContinuationGithubSnapshot(
        wrongPull.provider,
        REPOSITORY,
        PROJECT_ID,
        [task(517, { activePullRequestNumber: 600 })],
        OBSERVED_AT,
      ),
    "REPOSITORY_EVIDENCE_MISMATCH",
  );
});

test("oversized GitHub evidence is rejected without fabricating a partial snapshot", async () => {
  const oversized = Array.from({ length: MAX_CONTINUATION_PROVIDER_RECORDS + 1 }, (_, index) =>
    issue(index + 1),
  );
  const { provider } = fakeProvider(oversized);
  await expectError(
    () => readContinuationGithubSnapshot(provider, REPOSITORY, PROJECT_ID, [], OBSERVED_AT),
    "TOO_MANY_RECORDS",
  );
});

test("source stays detached and exposes only existing GitHub read methods", () => {
  const source = readFileSync(resolve("src/shared/continuation-github-snapshot.ts"), "utf8");

  assert.doesNotMatch(source, /\b(?:fetch|send|enqueue|schedule|deploy|merge)\s*\(/u);
  assert.doesNotMatch(source, /(?:CONTROL_NOTIFICATION_|CLOUDFLARE_|GITHUB_TOKEN)/u);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:worker|integrations|queue|notification)/u);
});
