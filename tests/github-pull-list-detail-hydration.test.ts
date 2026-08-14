import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGitHubInstallationReadScope,
  type GitHubCredentialLeaseEvidence,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
  type GitHubReadResult,
} from "../src/integrations/github/app-installation-read-contract.js";
import {
  GitHubAuthoritativeReadProviderError,
  createGitHubAuthoritativeReadProvider,
} from "../src/integrations/github/authoritative-read-provider.js";
import type { GitHubGraphqlMergeStateTransport } from "../src/integrations/github/graphql-merge-state-transport.js";

const repository = "rozkalnsandris/hermes-tech";
const observedAt = "2026-08-15T00:00:00.000Z";
const headSha = "1111111111111111111111111111111111111111";
const otherHeadSha = "2222222222222222222222222222222222222222";
const mainSha = "3333333333333333333333333333333333333333";

function scope(): GitHubInstallationReadScope {
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
    },
  });
}

function lease(readScope: GitHubInstallationReadScope): GitHubCredentialLeaseEvidence {
  return {
    installationId: readScope.installationId,
    repositories: readScope.repositories,
    permissions: readScope.permissions,
    issuedAt: observedAt,
    expiresAt: "2026-08-15T00:30:00.000Z",
  };
}

function listPayload() {
  return {
    number: 42,
    title: "Dashboard list contract",
    state: "open",
    draft: false,
    base: { ref: "main", sha: mainSha },
    head: { ref: "fix/dashboard", sha: headSha },
    html_url: "https://github.com/rozkalnsandris/hermes-tech/pull/42",
  };
}

function detailPayload(detailHeadSha = headSha) {
  return {
    ...listPayload(),
    head: { ref: "fix/dashboard", sha: detailHeadSha },
    changed_files: 7,
  };
}

function provider(detailHeadSha = headSha, calls: string[] = []) {
  const readScope = scope();
  const restTransport: GitHubInstallationReadTransport = {
    async get<T>(_scope, request): Promise<GitHubReadResult<T>> {
      calls.push(request.path);
      let pages: readonly unknown[];
      if (request.path === `/repos/${repository}/pulls?state=open&per_page=100`) {
        pages = [[listPayload()]];
      } else if (request.path === `/repos/${repository}/pulls/42`) {
        pages = [detailPayload(detailHeadSha)];
      } else {
        throw new Error(`Unexpected REST path: ${request.path}`);
      }
      return {
        pages: pages as readonly T[],
        credentialLease: lease(readScope),
        requestCount: 1,
        rateLimit: null,
      };
    },
  };
  const graphqlMergeStateTransport: GitHubGraphqlMergeStateTransport = {
    async read() {
      throw new Error("GraphQL must not be used by pull-list hydration");
    },
  };

  return createGitHubAuthoritativeReadProvider({
    scope: readScope,
    observedAt,
    restTransport,
    graphqlMergeStateTransport,
  });
}

test("hydrates GitHub list-pull entries that omit changed_files from the singular pull endpoint", async () => {
  const calls: string[] = [];
  const pulls = await provider(headSha, calls).listOpenPullRequests(repository);

  assert.equal(pulls.length, 1);
  assert.equal(pulls[0]?.number, 42);
  assert.equal(pulls[0]?.headSha, headSha);
  assert.equal(pulls[0]?.changedFiles, 7);
  assert.deepEqual(calls, [
    `/repos/${repository}/pulls?state=open&per_page=100`,
    `/repos/${repository}/pulls/42`,
  ]);
});

test("fails closed when singular pull detail no longer matches the listed head", async () => {
  await assert.rejects(
    () => provider(otherHeadSha).listOpenPullRequests(repository),
    (error) =>
      error instanceof GitHubAuthoritativeReadProviderError &&
      error.code === "MALFORMED_RESPONSE",
  );
});
