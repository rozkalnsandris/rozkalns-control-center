import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGitHubInstallationReadScope,
  type GitHubCredentialLeaseEvidence,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
  type GitHubReadRequest,
  type GitHubReadResult,
} from "../src/integrations/github/app-installation-read-contract.js";
import {
  GitHubAuthoritativeReadProviderError,
  createGitHubAuthoritativeReadProvider,
  readGitHubAuthoritativePullRequestSnapshot,
} from "../src/integrations/github/authoritative-read-provider.js";
import type {
  GitHubGraphqlMergeStateRequest,
  GitHubGraphqlMergeStateResult,
  GitHubGraphqlMergeStateTransport,
} from "../src/integrations/github/graphql-merge-state-transport.js";

const repository = "rozkalnsandris/hermes-tech";
const observedAt = "2026-08-11T22:05:00.000Z";
const headSha = "1111111111111111111111111111111111111111";
const staleSha = "2222222222222222222222222222222222222222";
const mainSha = "3333333333333333333333333333333333333333";

function scope(includeStatuses = true): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 4321,
    repositories: [repository],
    permissions: {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "read",
      checks: "read",
      actions: "read",
      ...(includeStatuses ? { statuses: "read" } : {}),
    },
  });
}

function lease(readScope: GitHubInstallationReadScope): GitHubCredentialLeaseEvidence {
  return {
    installationId: readScope.installationId,
    repositories: readScope.repositories,
    permissions: readScope.permissions,
    issuedAt: observedAt,
    expiresAt: "2026-08-11T23:00:00.000Z",
  };
}

function pullPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Provider adapter",
    state: "open",
    draft: false,
    base: { ref: "main", sha: mainSha },
    head: { ref: "feat/provider", sha: headSha },
    changed_files: 5,
    html_url: "https://github.com/rozkalnsandris/hermes-tech/pull/42",
    ...overrides,
  };
}

function checkPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    name: "validate",
    status: "completed",
    conclusion: "success",
    head_sha: headSha,
    app: { id: 15368 },
    started_at: "2026-08-11T22:01:00Z",
    completed_at: "2026-08-11T22:02:00Z",
    details_url: "https://github.com/example/check/10",
    ...overrides,
  };
}

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    context: "validate",
    state: "success",
    sha: headSha,
    target_url: "https://ci.example/status/20",
    created_at: "2026-08-11T22:02:00Z",
    ...overrides,
  };
}

function workflowPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 30,
    workflow_id: 100,
    run_number: 7,
    run_attempt: 1,
    name: "CI",
    status: "completed",
    conclusion: "success",
    head_sha: headSha,
    created_at: "2026-08-11T22:00:00Z",
    updated_at: "2026-08-11T22:03:00Z",
    run_started_at: "2026-08-11T22:01:00Z",
    html_url: "https://github.com/example/actions/runs/30",
    ...overrides,
  };
}

interface RestCall {
  readonly request: GitHubReadRequest;
  readonly observedAt: string;
}

function fakeRestTransport(
  readScope: GitHubInstallationReadScope,
  pagesForPath: (path: string) => readonly unknown[],
  calls: RestCall[],
): GitHubInstallationReadTransport {
  return {
    async get<T>(
      _scope: GitHubInstallationReadScope,
      request: GitHubReadRequest,
      callObservedAt: string,
    ): Promise<GitHubReadResult<T>> {
      calls.push({ request, observedAt: callObservedAt });
      return {
        pages: pagesForPath(request.path) as readonly T[],
        credentialLease: lease(readScope),
        requestCount: 1,
        rateLimit: null,
      };
    },
  };
}

interface GraphqlCall {
  readonly request: GitHubGraphqlMergeStateRequest;
  readonly observedAt: string;
}

function fakeGraphqlTransport(
  readScope: GitHubInstallationReadScope,
  calls: GraphqlCall[],
): GitHubGraphqlMergeStateTransport {
  return {
    async read(
      _scope: GitHubInstallationReadScope,
      request: GitHubGraphqlMergeStateRequest,
      callObservedAt: string,
    ): Promise<GitHubGraphqlMergeStateResult> {
      calls.push({ request, observedAt: callObservedAt });
      return {
        mergeState: {
          pullNumber: request.pullNumber,
          headSha,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          draft: false,
        },
        credentialLease: lease(readScope),
        rateLimit: null,
      };
    },
  };
}

function standardPages(path: string): readonly unknown[] {
  const paths = new Map<string, readonly unknown[]>([
    [`/repos/${repository}`, [{ full_name: repository, default_branch: "main" }]],
    [`/repos/${repository}/branches/main`, [{ name: "main", commit: { sha: mainSha } }]],
    [
      `/repos/${repository}/issues?state=open&per_page=100`,
      [[
        {
          number: 5,
          title: "Real issue",
          state: "open",
          html_url: "https://github.com/rozkalnsandris/hermes-tech/issues/5",
        },
        {
          number: 42,
          title: "PR surfaced as issue",
          state: "open",
          html_url: "https://github.com/rozkalnsandris/hermes-tech/issues/42",
          pull_request: { url: "https://api.github.com/example/pulls/42" },
        },
      ]],
    ],
    [`/repos/${repository}/pulls?state=open&per_page=100`, [[pullPayload()]]],
    [`/repos/${repository}/pulls/42`, [pullPayload()]],
    [
      `/repos/${repository}/pulls/42/reviews?per_page=100`,
      [[{ id: 40, state: "APPROVED", user: { login: "reviewer" }, submitted_at: "2026-08-11T22:03:00Z" }]],
    ],
    [
      `/repos/${repository}/commits/${headSha}/check-runs?filter=all&per_page=100`,
      [{ total_count: 2, check_runs: [checkPayload({ id: 9, head_sha: staleSha }), checkPayload()] }],
    ],
    [
      `/repos/${repository}/commits/${headSha}/statuses?per_page=100`,
      [[statusPayload({ id: 19, sha: staleSha }), statusPayload()]],
    ],
    [
      `/repos/${repository}/actions/runs?head_sha=${headSha}&per_page=100`,
      [{ total_count: 2, workflow_runs: [workflowPayload({ id: 29, head_sha: staleSha }), workflowPayload()] }],
    ],
  ]);
  const pages = paths.get(path);
  if (!pages) throw new Error(`Unexpected fake REST path: ${path}`);
  return pages;
}

function providerErrorCode(error: unknown): string | undefined {
  return error instanceof GitHubAuthoritativeReadProviderError ? error.code : undefined;
}

test("implements the provider-neutral read interface with fixed endpoint and permission bindings", async () => {
  const readScope = scope();
  const restCalls: RestCall[] = [];
  const graphqlCalls: GraphqlCall[] = [];
  const provider = createGitHubAuthoritativeReadProvider({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(readScope, standardPages, restCalls),
    graphqlMergeStateTransport: fakeGraphqlTransport(readScope, graphqlCalls),
  });

  assert.deepEqual(await provider.getRepository(repository), { repository, defaultBranch: "main" });
  assert.equal(await provider.getDefaultBranchHead(repository, "main"), mainSha);
  assert.deepEqual(await provider.listOpenIssues(repository), [
    {
      number: 5,
      title: "Real issue",
      state: "open",
      htmlUrl: "https://github.com/rozkalnsandris/hermes-tech/issues/5",
    },
  ]);
  assert.equal((await provider.listOpenPullRequests(repository)).length, 1);
  assert.equal((await provider.getPullRequest(repository, 42)).headSha, headSha);
  assert.equal((await provider.getPullRequestMergeState(repository, 42)).mergeStateStatus, "CLEAN");
  assert.equal((await provider.listPullRequestReviews(repository, 42))[0]?.state, "APPROVED");
  assert.deepEqual((await provider.listCheckRuns(repository, headSha)).map((item) => item.headSha), [headSha]);
  assert.deepEqual((await provider.listCommitStatuses(repository, headSha)).map((item) => item.headSha), [headSha]);
  assert.deepEqual((await provider.listWorkflowRuns(repository, headSha)).map((item) => item.headSha), [headSha]);

  assert.deepEqual(
    restCalls.map(({ request }) => [request.path, request.requiredPermission]),
    [
      [`/repos/${repository}`, "metadata"],
      [`/repos/${repository}/branches/main`, "contents"],
      [`/repos/${repository}/issues?state=open&per_page=100`, "issues"],
      [`/repos/${repository}/pulls?state=open&per_page=100`, "pull_requests"],
      [`/repos/${repository}/pulls/42`, "pull_requests"],
      [`/repos/${repository}/pulls/42/reviews?per_page=100`, "pull_requests"],
      [`/repos/${repository}/commits/${headSha}/check-runs?filter=all&per_page=100`, "checks"],
      [`/repos/${repository}/commits/${headSha}/statuses?per_page=100`, "statuses"],
      [`/repos/${repository}/actions/runs?head_sha=${headSha}&per_page=100`, "actions"],
    ],
  );
  assert.ok(restCalls.every((call) => call.observedAt === observedAt));
  assert.deepEqual(graphqlCalls, [{ request: { repository, pullNumber: 42 }, observedAt }]);
});

test("composed authoritative snapshot uses one observation time and skips statuses when not requested", async () => {
  const readScope = scope(false);
  const restCalls: RestCall[] = [];
  const graphqlCalls: GraphqlCall[] = [];
  const restTransport = fakeRestTransport(
    readScope,
    (path) => {
      assert.doesNotMatch(path, /\/statuses(?:\?|$)/);
      return standardPages(path);
    },
    restCalls,
  );

  const snapshot = await readGitHubAuthoritativePullRequestSnapshot({
    scope: readScope,
    observedAt,
    restTransport,
    graphqlMergeStateTransport: fakeGraphqlTransport(readScope, graphqlCalls),
    repository,
    pullNumber: 42,
    commitStatusCoverage: "NOT_REQUESTED",
  });

  assert.equal(snapshot.observedAt, observedAt);
  assert.equal(snapshot.commitStatusCoverage, "NOT_REQUESTED");
  assert.deepEqual(snapshot.commitStatuses, []);
  assert.equal(snapshot.mainSha, mainSha);
  assert.equal(snapshot.pullRequest.headSha, headSha);
  assert.ok(restCalls.every((call) => call.observedAt === observedAt));
  assert.ok(restCalls.every((call) => call.request.requiredPermission !== "statuses"));
  assert.deepEqual(graphqlCalls, [{ request: { repository, pullNumber: 42 }, observedAt }]);
});

test("missing conditional commit-status permission fails before transport if the provider method is called directly", async () => {
  const readScope = scope(false);
  let restCalls = 0;
  const provider = createGitHubAuthoritativeReadProvider({
    scope: readScope,
    observedAt,
    restTransport: {
      async get<T>(): Promise<GitHubReadResult<T>> {
        restCalls += 1;
        throw new Error("must not execute");
      },
    },
    graphqlMergeStateTransport: fakeGraphqlTransport(readScope, []),
  });

  await assert.rejects(
    () => provider.listCommitStatuses(repository, headSha),
    (error) => providerErrorCode(error) === "INVALID_REQUEST",
  );
  assert.equal(restCalls, 0);
});

test("fails closed on malformed or mismatched singular and collection payloads", async () => {
  const readScope = scope();
  const cases: [string, () => Promise<unknown>][] = [];

  const branchMismatch = createGitHubAuthoritativeReadProvider({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(
      readScope,
      (path) =>
        path.endsWith("/branches/main") ? [{ name: "other", commit: { sha: mainSha } }] : standardPages(path),
      [],
    ),
    graphqlMergeStateTransport: fakeGraphqlTransport(readScope, []),
  });
  cases.push(["branch mismatch", () => branchMismatch.getDefaultBranchHead(repository, "main")]);

  const malformedIssues = createGitHubAuthoritativeReadProvider({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(
      readScope,
      (path) => (path.includes("/issues?") ? [{ not: "an array page" }] : standardPages(path)),
      [],
    ),
    graphqlMergeStateTransport: fakeGraphqlTransport(readScope, []),
  });
  cases.push(["issue page shape", () => malformedIssues.listOpenIssues(repository)]);

  const closedPull = createGitHubAuthoritativeReadProvider({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(
      readScope,
      (path) => (path.includes("/pulls?state=open") ? [[pullPayload({ state: "closed" })]] : standardPages(path)),
      [],
    ),
    graphqlMergeStateTransport: fakeGraphqlTransport(readScope, []),
  });
  cases.push(["unexpected closed PR", () => closedPull.listOpenPullRequests(repository)]);

  const malformedChecks = createGitHubAuthoritativeReadProvider({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(
      readScope,
      (path) => (path.includes("/check-runs?") ? [{ total_count: 1 }] : standardPages(path)),
      [],
    ),
    graphqlMergeStateTransport: fakeGraphqlTransport(readScope, []),
  });
  cases.push(["check wrapper shape", () => malformedChecks.listCheckRuns(repository, headSha)]);

  for (const [label, action] of cases) {
    await assert.rejects(action, (error) => providerErrorCode(error) === "MALFORMED_RESPONSE", label);
  }
});

test("rejects invalid observation time, unmanaged repository and invalid pull number before GraphQL transport", async () => {
  const readScope = scope();
  assert.throws(
    () =>
      createGitHubAuthoritativeReadProvider({
        scope: readScope,
        observedAt: "not-a-time",
        restTransport: fakeRestTransport(readScope, standardPages, []),
        graphqlMergeStateTransport: fakeGraphqlTransport(readScope, []),
      }),
    (error) => providerErrorCode(error) === "INVALID_REQUEST",
  );

  const graphqlCalls: GraphqlCall[] = [];
  const provider = createGitHubAuthoritativeReadProvider({
    scope: readScope,
    observedAt,
    restTransport: fakeRestTransport(readScope, standardPages, []),
    graphqlMergeStateTransport: fakeGraphqlTransport(readScope, graphqlCalls),
  });

  await assert.rejects(
    () => provider.getRepository("rozkalnsandris/not-managed"),
    (error) => providerErrorCode(error) === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => provider.getPullRequestMergeState(repository, 0),
    (error) => providerErrorCode(error) === "INVALID_REQUEST",
  );
  assert.equal(graphqlCalls.length, 0);
});
