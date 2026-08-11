import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGitHubInstallationReadScope,
  type GitHubCredentialLeaseEvidence,
  type GitHubInstallationReadScope,
} from "../src/integrations/github/app-installation-read-contract.js";
import {
  GitHubAppSessionError,
  createGitHubAppInstallationGraphqlSessionProvider,
  type GitHubAppJwtSigner,
} from "../src/integrations/github/app-installation-session.js";
import {
  GITHUB_GRAPHQL_ACCEPT,
  GITHUB_GRAPHQL_CONTENT_TYPE,
  GITHUB_GRAPHQL_ENDPOINT,
  GITHUB_GRAPHQL_MERGE_STATE_OPERATION,
  GITHUB_GRAPHQL_MERGE_STATE_QUERY,
  GitHubGraphqlMergeStateError,
  createGitHubGraphqlMergeStateTransport,
  type GitHubAuthorizedGraphqlMergeStateQuery,
  type GitHubInstallationAuthorizedGraphqlQuerySession,
  type GitHubInstallationAuthorizedGraphqlQuerySessionProvider,
} from "../src/integrations/github/graphql-merge-state-transport.js";

const observedAt = "2026-08-11T21:15:00.000Z";
const resetAt = "2026-08-11T21:30:00.000Z";
const resetEpochSeconds = Math.floor(Date.parse(resetAt) / 1000);

function scope(overrides: Record<string, unknown> = {}): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 321,
    repositories: ["rozkalnsandris/hermes-tech"],
    permissions: { pull_requests: "read" },
    ...overrides,
  });
}

function lease(readScope = scope()): GitHubCredentialLeaseEvidence {
  return {
    installationId: readScope.installationId,
    repositories: readScope.repositories,
    permissions: readScope.permissions,
    issuedAt: observedAt,
    expiresAt: "2026-08-11T22:15:00.000Z",
  };
}

function graphqlBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          number: 42,
          headRefOid: "0123456789abcdef0123456789abcdef01234567",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          isDraft: false,
        },
      },
    },
    ...overrides,
  };
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function fakeSessionProvider(
  execute: (request: GitHubAuthorizedGraphqlMergeStateQuery) => Promise<Response>,
  readScope = scope(),
): GitHubInstallationAuthorizedGraphqlQuerySessionProvider {
  return async () => ({ credentialLease: lease(readScope), execute });
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof GitHubGraphqlMergeStateError || error instanceof GitHubAppSessionError) return error.code;
  return undefined;
}

test("executes only the fixed merge-state query with exact variables and maps sanitized evidence", async () => {
  let captured: GitHubAuthorizedGraphqlMergeStateQuery | undefined;
  const transport = createGitHubGraphqlMergeStateTransport(
    fakeSessionProvider(async (request) => {
      captured = request;
      return response(graphqlBody(), 200, {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-used": "1",
        "x-ratelimit-reset": String(resetEpochSeconds),
        "x-ratelimit-resource": "graphql",
      });
    }),
  );

  const result = await transport.read(
    scope(),
    { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 },
    observedAt,
  );

  assert.ok(captured);
  assert.deepEqual(captured, {
    method: "POST",
    url: GITHUB_GRAPHQL_ENDPOINT,
    accept: GITHUB_GRAPHQL_ACCEPT,
    contentType: GITHUB_GRAPHQL_CONTENT_TYPE,
    operationName: GITHUB_GRAPHQL_MERGE_STATE_OPERATION,
    query: GITHUB_GRAPHQL_MERGE_STATE_QUERY,
    variables: { owner: "rozkalnsandris", name: "hermes-tech", number: 42 },
    redirect: "manual",
  });
  assert.deepEqual(result.mergeState, {
    pullNumber: 42,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    draft: false,
  });
  assert.deepEqual(result.rateLimit, {
    limit: 5000,
    remaining: 4999,
    used: 1,
    resetAt,
    resource: "graphql",
  });
  assert.deepEqual(result.credentialLease, lease());
});

test("rejects invalid repository, pull number or missing pull-request permission before acquiring a session", async () => {
  let acquisitions = 0;
  const transport = createGitHubGraphqlMergeStateTransport(async () => {
    acquisitions += 1;
    throw new Error("should not acquire");
  });

  await assert.rejects(
    () => transport.read(scope(), { repository: "rozkalnsandris/hermes-deals", pullNumber: 42 }, observedAt),
    (error) => errorCode(error) === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => transport.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 0 }, observedAt),
    (error) => errorCode(error) === "INVALID_REQUEST",
  );
  const metadataOnly = scope({ permissions: { metadata: "read" } });
  await assert.rejects(
    () => transport.read(metadataOnly, { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
    (error) => errorCode(error) === "INVALID_REQUEST",
  );
  assert.equal(acquisitions, 0);
});

test("fails closed on GraphQL errors even when partial data is present", async () => {
  const transport = createGitHubGraphqlMergeStateTransport(
    fakeSessionProvider(async () =>
      response({
        ...graphqlBody(),
        errors: [{ message: "remote-sensitive-detail", path: ["repository", "pullRequest"] }],
      }),
    ),
  );

  await assert.rejects(
    () => transport.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
    (error) =>
      error instanceof GitHubGraphqlMergeStateError &&
      error.code === "GRAPHQL_ERROR" &&
      !error.message.includes("remote-sensitive-detail"),
  );
});

test("recognizes primary rate limit exhaustion from HTTP 200 headers before trusting GraphQL data", async () => {
  const transport = createGitHubGraphqlMergeStateTransport(
    fakeSessionProvider(async () =>
      response(
        { errors: [{ message: "API rate limit exceeded" }] },
        200,
        {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-used": "5000",
          "x-ratelimit-reset": String(resetEpochSeconds),
          "x-ratelimit-resource": "graphql",
        },
      ),
    ),
  );

  await assert.rejects(
    () => transport.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
    (error) =>
      error instanceof GitHubGraphqlMergeStateError &&
      error.code === "RATE_LIMITED" &&
      error.status === 200 &&
      error.retryNotBefore === resetAt &&
      error.rateLimit?.resource === "graphql",
  );
});

test("recognizes secondary rate limiting from retry-after without automatic retry", async () => {
  let executeCount = 0;
  const transport = createGitHubGraphqlMergeStateTransport(
    fakeSessionProvider(async () => {
      executeCount += 1;
      return response(
        { errors: [{ message: "secondary limit" }] },
        200,
        { "retry-after": "60", "x-ratelimit-resource": "graphql" },
      );
    }),
  );

  await assert.rejects(
    () => transport.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
    (error) =>
      error instanceof GitHubGraphqlMergeStateError &&
      error.code === "RATE_LIMITED" &&
      error.retryNotBefore === "2026-08-11T21:16:00.000Z",
  );
  assert.equal(executeCount, 1);
});

test("maps unauthorized, ordinary forbidden and unexpected HTTP status fail closed", async () => {
  const cases: readonly [number, string][] = [
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [500, "UNEXPECTED_STATUS"],
  ];
  for (const [status, expected] of cases) {
    const transport = createGitHubGraphqlMergeStateTransport(
      fakeSessionProvider(async () => response({ remote: "do-not-copy" }, status)),
    );
    await assert.rejects(
      () => transport.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
      (error) =>
        error instanceof GitHubGraphqlMergeStateError &&
        error.code === expected &&
        error.status === status &&
        !error.message.includes("do-not-copy"),
    );
  }
});

test("fails closed when repository or pull request is absent", async () => {
  for (const body of [
    { data: { repository: null } },
    { data: { repository: { pullRequest: null } } },
  ]) {
    const transport = createGitHubGraphqlMergeStateTransport(fakeSessionProvider(async () => response(body)));
    await assert.rejects(
      () => transport.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
      (error) => errorCode(error) === "RESOURCE_NOT_FOUND",
    );
  }
});

test("rejects malformed envelope, mismatched pull number, malformed headers and non-JSON content", async () => {
  const bodies = [
    { data: null },
    { data: { repository: {} } },
    graphqlBody({ data: { repository: { pullRequest: { ...graphqlBody().data.repository.pullRequest, number: 43 } } } }),
    { errors: [] },
  ];
  for (const body of bodies) {
    const transport = createGitHubGraphqlMergeStateTransport(fakeSessionProvider(async () => response(body)));
    await assert.rejects(
      () => transport.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
      (error) => errorCode(error) === "MALFORMED_RESPONSE",
    );
  }

  const badRateHeader = createGitHubGraphqlMergeStateTransport(
    fakeSessionProvider(async () => response(graphqlBody(), 200, { "x-ratelimit-remaining": "not-a-number" })),
  );
  await assert.rejects(
    () => badRateHeader.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
    (error) => errorCode(error) === "MALFORMED_RESPONSE",
  );

  const wrongResource = createGitHubGraphqlMergeStateTransport(
    fakeSessionProvider(async () => response(graphqlBody(), 200, { "x-ratelimit-resource": "core" })),
  );
  await assert.rejects(
    () => wrongResource.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
    (error) => errorCode(error) === "MALFORMED_RESPONSE",
  );

  const nonJson = createGitHubGraphqlMergeStateTransport(
    fakeSessionProvider(async () => new Response("remote-body", { status: 200, headers: { "content-type": "text/plain" } })),
  );
  await assert.rejects(
    () => nonJson.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
    (error) => errorCode(error) === "MALFORMED_RESPONSE",
  );
});

test("sanitizes credential acquisition and transport failures", async () => {
  const credentialFailure = createGitHubGraphqlMergeStateTransport(async () => {
    throw new Error("private-credential-detail");
  });
  await assert.rejects(
    () => credentialFailure.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
    (error) =>
      error instanceof GitHubGraphqlMergeStateError &&
      error.code === "CREDENTIAL_UNAVAILABLE" &&
      !error.message.includes("private-credential-detail"),
  );

  const transportFailure = createGitHubGraphqlMergeStateTransport(
    fakeSessionProvider(async () => {
      throw new Error("network-sensitive-detail");
    }),
  );
  await assert.rejects(
    () => transportFailure.read(scope(), { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 }, observedAt),
    (error) =>
      error instanceof GitHubGraphqlMergeStateError &&
      error.code === "TRANSPORT_FAILURE" &&
      !error.message.includes("network-sensitive-detail"),
  );
});

function signer(): GitHubAppJwtSigner {
  return {
    async signRs256() {
      return new Uint8Array([4, 3, 2, 1]);
    },
  };
}

function tokenResponse(rawCredential = "opaque-graphql-installation-credential"): Response {
  return response(
    {
      token: rawCredential,
      expires_at: "2026-08-11T22:15:00.000Z",
      permissions: { pull_requests: "read" },
      repository_selection: "selected",
      repositories: [{ full_name: "rozkalnsandris/hermes-tech" }],
    },
    201,
  );
}

test("concrete GitHub App GraphQL session reuses installation credential boundary and keeps raw token internal", async () => {
  const requests: Request[] = [];
  const rawCredential = "opaque-graphql-installation-credential";
  const provider = createGitHubAppInstallationGraphqlSessionProvider({
    identity: { clientId: "control-client" },
    signer: signer(),
    fetchRequest: async (request) => {
      requests.push(request.clone());
      if (request.url.includes("/app/installations/")) return tokenResponse(rawCredential);
      return response(graphqlBody());
    },
  });
  const transport = createGitHubGraphqlMergeStateTransport(provider);
  const result = await transport.read(
    scope(),
    { repository: "rozkalnsandris/hermes-tech", pullNumber: 42 },
    observedAt,
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "https://api.github.com/app/installations/321/access_tokens");
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].url, GITHUB_GRAPHQL_ENDPOINT);
  assert.equal(requests[1].redirect, "manual");
  assert.equal(requests[1].headers.get("accept"), GITHUB_GRAPHQL_ACCEPT);
  assert.equal(requests[1].headers.get("content-type"), GITHUB_GRAPHQL_CONTENT_TYPE);
  assert.equal(requests[1].headers.get("authorization"), `Bearer ${rawCredential}`);
  assert.equal(requests[1].headers.get("x-github-api-version"), null);
  assert.deepEqual(JSON.parse(await requests[1].text()), {
    operationName: GITHUB_GRAPHQL_MERGE_STATE_OPERATION,
    query: GITHUB_GRAPHQL_MERGE_STATE_QUERY,
    variables: { owner: "rozkalnsandris", name: "hermes-tech", number: 42 },
  });
  assert.equal(JSON.stringify(result).includes(rawCredential), false);
});

test("concrete authorized GraphQL session rejects query tampering before authenticated GraphQL HTTP", async () => {
  let fetchCount = 0;
  const provider = createGitHubAppInstallationGraphqlSessionProvider({
    identity: { clientId: "control-client" },
    signer: signer(),
    fetchRequest: async (request) => {
      fetchCount += 1;
      return request.url.includes("/app/installations/") ? tokenResponse() : response(graphqlBody());
    },
  });
  const session: GitHubInstallationAuthorizedGraphqlQuerySession = await provider(scope(), observedAt);
  assert.equal(fetchCount, 1);

  const valid: GitHubAuthorizedGraphqlMergeStateQuery = {
    method: "POST",
    url: GITHUB_GRAPHQL_ENDPOINT,
    accept: GITHUB_GRAPHQL_ACCEPT,
    contentType: GITHUB_GRAPHQL_CONTENT_TYPE,
    operationName: GITHUB_GRAPHQL_MERGE_STATE_OPERATION,
    query: GITHUB_GRAPHQL_MERGE_STATE_QUERY,
    variables: { owner: "rozkalnsandris", name: "hermes-tech", number: 42 },
    redirect: "manual",
  };

  await assert.rejects(
    () => session.execute({ ...valid, query: "mutation Dangerous { __typename }" as typeof GITHUB_GRAPHQL_MERGE_STATE_QUERY }),
    (error) => errorCode(error) === "GRAPHQL_REQUEST_INVALID",
  );
  await assert.rejects(
    () => session.execute({ ...valid, variables: { owner: "rozkalnsandris", name: "hermes-deals", number: 42 } }),
    (error) => errorCode(error) === "GRAPHQL_REQUEST_INVALID",
  );
  assert.equal(fetchCount, 1);
});
