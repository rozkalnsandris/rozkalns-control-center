import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubAppInstallationDashboardGraphqlSessionProvider } from "../src/integrations/github/app-installation-dashboard-session.js";
import type { GitHubAppJwtSigner } from "../src/integrations/github/app-installation-session.js";
import { buildPhase2GitHubReadScopeForStage } from "../src/integrations/github/app-read-rollout-plan.js";
import {
  GITHUB_DASHBOARD_FREE_SUBREQUEST_LIMIT,
  GITHUB_DASHBOARD_MAX_EXTERNAL_SUBREQUESTS,
  GITHUB_GRAPHQL_DASHBOARD_OPERATION,
  GITHUB_GRAPHQL_DASHBOARD_QUERY,
  GitHubDashboardSnapshotError,
  createGitHubDashboardReadContextFactory,
} from "../src/integrations/github/graphql-dashboard-snapshot.js";
import { readLiveDashboardSnapshot } from "../src/shared/live-dashboard.js";

const OBSERVED_AT = "2026-08-15T00:10:00.000Z";
const EXPIRES_AT = "2026-08-15T01:10:00.000Z";
const MAIN_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";

function signer(): GitHubAppJwtSigner {
  return {
    async signRs256() {
      return new Uint8Array([1, 2, 3, 4]);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function repositoryEnvelope(repository: string, withPull: boolean, paginated = false) {
  const linkedIssue = {
    number: 101,
    title: "Open issue",
    state: "OPEN",
    url: `https://github.com/${repository}/issues/101`,
  };
  const pull = {
    number: 7,
    title: "Bound dashboard read",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    baseRefOid: MAIN_SHA,
    headRefName: "fix/dashboard",
    headRefOid: HEAD_SHA,
    changedFiles: 4,
    url: `https://github.com/${repository}/pull/7`,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    closingIssuesReferences: {
      totalCount: 1,
      pageInfo: { hasNextPage: false },
      nodes: [linkedIssue],
    },
    latestReviews: {
      pageInfo: { hasNextPage: false },
      nodes: [{ id: "PRR_1", state: "APPROVED", author: { login: "reviewer" }, submittedAt: OBSERVED_AT }],
    },
    statusCheckRollup: {
      contexts: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            __typename: "CheckRun",
            id: "CR_1",
            databaseId: 10,
            name: "validate",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            startedAt: OBSERVED_AT,
            completedAt: OBSERVED_AT,
            detailsUrl: null,
            checkSuite: {
              status: "COMPLETED",
              conclusion: "SUCCESS",
              app: { databaseId: 15368 },
              workflowRun: {
                id: "WFR_1",
                databaseId: 20,
                runNumber: 3,
                runAttempt: 1,
                createdAt: OBSERVED_AT,
                updatedAt: OBSERVED_AT,
                url: `https://github.com/${repository}/actions/runs/20`,
                workflow: { databaseId: 30, name: "CI" },
              },
            },
          },
        ],
      },
    },
  };

  return {
    data: {
      repository: {
        nameWithOwner: repository,
        defaultBranchRef: { name: "main", target: { oid: MAIN_SHA } },
        issues: {
          totalCount: 1,
          pageInfo: { hasNextPage: false },
          nodes: [linkedIssue],
        },
        pullRequests: {
          totalCount: withPull ? 1 : 0,
          pageInfo: { hasNextPage: paginated },
          nodes: withPull ? [pull] : [],
        },
      },
    },
  };
}

test("dashboard reuses one exact-six-repository token and stays well below the Cloudflare Free subrequest limit", async () => {
  const scope = buildPhase2GitHubReadScopeForStage(123, "actions");
  let externalSubrequests = 0;
  let tokenExchanges = 0;
  let graphqlReads = 0;

  const fetchRequest = async (request: Request): Promise<Response> => {
    externalSubrequests += 1;
    if (request.url.includes("/app/installations/123/access_tokens")) {
      tokenExchanges += 1;
      const body = JSON.parse(await request.text()) as { repositories: string[]; permissions: Record<string, string> };
      assert.deepEqual(body.repositories, scope.repositories.map((repository) => repository.split("/")[1]));
      assert.deepEqual(body.permissions, scope.permissions);
      return json(
        {
          token: "test-only-opaque-dashboard-token",
          expires_at: EXPIRES_AT,
          permissions: scope.permissions,
          repository_selection: "selected",
          repositories: scope.repositories.map((repository) => ({ full_name: repository })),
        },
        201,
      );
    }

    assert.equal(request.url, "https://api.github.com/graphql");
    graphqlReads += 1;
    const body = JSON.parse(await request.text()) as {
      operationName: string;
      query: string;
      variables: { owner: string; name: string };
    };
    assert.equal(body.operationName, GITHUB_GRAPHQL_DASHBOARD_OPERATION);
    assert.equal(body.query, GITHUB_GRAPHQL_DASHBOARD_QUERY);
    const repository = `${body.variables.owner}/${body.variables.name}`;
    assert.equal(scope.repositories.includes(repository), true);
    return json(repositoryEnvelope(repository, repository.endsWith("/hermes-deals")));
  };

  const acquireSession = createGitHubAppInstallationDashboardGraphqlSessionProvider({
    identity: { clientId: "Iv23li-dashboard-test" },
    signer: signer(),
    fetchRequest,
  });
  const factory = await createGitHubDashboardReadContextFactory({ scope, observedAt: OBSERVED_AT, acquireSession });
  const snapshot = await readLiveDashboardSnapshot(factory, OBSERVED_AT);

  assert.equal(tokenExchanges, 1);
  assert.equal(graphqlReads, 6);
  assert.equal(externalSubrequests, GITHUB_DASHBOARD_MAX_EXTERNAL_SUBREQUESTS);
  assert.equal(externalSubrequests < GITHUB_DASHBOARD_FREE_SUBREQUEST_LIMIT, true);
  assert.equal(snapshot.projects.length, 6);
  assert.equal(snapshot.decisions.length, 1);
  assert.equal(snapshot.decisions[0]?.projectId, "hermes-deals");
  assert.equal(snapshot.decisions[0]?.issueNumber, 101);
  assert.equal(snapshot.decisions[0]?.issueTitle, "Open issue");
  assert.equal(snapshot.decisions[0]?.ci, "PASS");
  assert.equal(snapshot.decisions[0]?.review, "PENDING");
  assert.deepEqual(snapshot.decisions[0]?.allowedActions, ["OPEN_PR"]);
  assert.equal(snapshot.decisions.some((decision) => decision.workflowState === "MERGE_READY"), false);
  assert.equal(snapshot.decisions.some((decision) => decision.allowedActions.includes("MERGE")), false);
  assert.equal(snapshot.decisions.some((decision) => decision.allowedActions.includes("NEEDS_CHANGES")), false);
});

test("dashboard fails closed instead of paginating beyond the bounded GraphQL snapshot", async () => {
  const scope = buildPhase2GitHubReadScopeForStage(123, "actions");
  const acquireSession = async () => ({
    credentialLease: {
      installationId: scope.installationId,
      repositories: scope.repositories,
      permissions: scope.permissions,
      issuedAt: OBSERVED_AT,
      expiresAt: EXPIRES_AT,
    },
    async execute(request: { variables: { owner: string; name: string } }) {
      const repository = `${request.variables.owner}/${request.variables.name}`;
      return json(repositoryEnvelope(repository, false, repository.endsWith("/hermes-tech")));
    },
  });

  await assert.rejects(
    () => createGitHubDashboardReadContextFactory({ scope, observedAt: OBSERVED_AT, acquireSession }),
    (error) => error instanceof GitHubDashboardSnapshotError,
  );
});
