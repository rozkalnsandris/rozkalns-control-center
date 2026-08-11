import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubReadRequest,
  parseGitHubCredentialLeaseEvidence,
  parseGitHubInstallationReadScope,
} from "../src/integrations/github/app-installation-read-contract.js";
import {
  GITHUB_REST_ACCEPT,
  GITHUB_REST_ORIGIN,
  GitHubRestReadError,
  createGitHubRestReadTransport,
  type GitHubAuthorizedRestGet,
} from "../src/integrations/github/rest-read-transport.js";

const observedAt = "2026-08-11T07:30:00.000Z";

const scope = parseGitHubInstallationReadScope({
  installationId: 123,
  repositories: ["rozkalnsandris/hermes-tech", "rozkalnsandris/RPi5_main"],
  permissions: {
    metadata: "read",
    pull_requests: "read",
    actions: "read",
  },
});

const lease = parseGitHubCredentialLeaseEvidence({
  installationId: 123,
  repositories: ["rozkalnsandris/hermes-tech", "rozkalnsandris/RPi5_main"],
  permissions: {
    metadata: "read",
    pull_requests: "read",
    actions: "read",
  },
  issuedAt: "2026-08-11T07:00:00.000Z",
  expiresAt: "2026-08-11T08:00:00.000Z",
});

function pullRequest(path = "/repos/rozkalnsandris/hermes-tech/pulls?per_page=100") {
  return createGitHubReadRequest(scope, "rozkalnsandris/hermes-tech", path, "pull_requests");
}

function jsonResponse(
  data: unknown,
  options: {
    status?: number;
    headers?: Record<string, string>;
  } = {},
) {
  return new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...options.headers,
    },
  });
}

function scriptedTransport(responses: readonly Response[], options: { maxRequests?: number } = {}) {
  const seen: GitHubAuthorizedRestGet[] = [];
  let index = 0;
  const transport = createGitHubRestReadTransport(async () => ({
    credentialLease: lease,
    async execute(request) {
      seen.push(request);
      const response = responses[index];
      index += 1;
      if (!response) throw new Error("script exhausted");
      return response;
    },
  }), options);
  return { transport, seen };
}

async function captureReadError(action: () => Promise<unknown>): Promise<GitHubRestReadError> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof GitHubRestReadError);
  return caught;
}

test("performs one repository-bound GET with integration-owned REST metadata", async () => {
  const { transport, seen } = scriptedTransport([
    jsonResponse(
      [{ number: 1 }],
      {
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-used": "1",
          "x-ratelimit-reset": "1786435500",
          "x-ratelimit-resource": "core",
        },
      },
    ),
  ]);

  const result = await transport.get<readonly { number: number }[]>(scope, pullRequest(), observedAt);

  assert.deepEqual(result.pages, [[{ number: 1 }]]);
  assert.equal(result.requestCount, 1);
  assert.deepEqual(result.rateLimit, {
    limit: 5000,
    remaining: 4999,
    used: 1,
    resetAt: "2026-08-11T08:05:00.000Z",
    resource: "core",
  });
  assert.equal(result.credentialLease.installationId, 123);

  assert.deepEqual(seen, [
    {
      method: "GET",
      url: `${GITHUB_REST_ORIGIN}/repos/rozkalnsandris/hermes-tech/pulls?per_page=100`,
      accept: GITHUB_REST_ACCEPT,
      apiVersion: "2026-03-10",
      redirect: "manual",
    },
  ]);
});

test("follows only sequential rel=next pagination and preserves page payloads", async () => {
  const { transport, seen } = scriptedTransport([
    jsonResponse([{ number: 1 }], {
      headers: {
        link: `<${GITHUB_REST_ORIGIN}/repos/rozkalnsandris/hermes-tech/pulls?per_page=1&page=2>; rel="next", <${GITHUB_REST_ORIGIN}/repos/rozkalnsandris/hermes-tech/pulls?per_page=1&page=2>; rel="last"`,
      },
    }),
    jsonResponse([{ number: 2 }]),
  ]);

  const result = await transport.get<readonly { number: number }[]>(
    scope,
    pullRequest("/repos/rozkalnsandris/hermes-tech/pulls?per_page=1&page=1"),
    observedAt,
  );

  assert.deepEqual(result.pages, [[{ number: 1 }], [{ number: 2 }]]);
  assert.equal(result.requestCount, 2);
  assert.equal(seen[1]?.url, `${GITHUB_REST_ORIGIN}/repos/rozkalnsandris/hermes-tech/pulls?per_page=1&page=2`);
});

test("stops after one page when Link is absent", async () => {
  const { transport, seen } = scriptedTransport([jsonResponse({ id: 1 })]);
  const result = await transport.get<{ id: number }>(scope, pullRequest(), observedAt);

  assert.deepEqual(result.pages, [{ id: 1 }]);
  assert.equal(seen.length, 1);
});

test("rejects off-origin and cross-repository pagination links", async () => {
  const offOrigin = scriptedTransport([
    jsonResponse([], {
      headers: {
        link: `<https://example.invalid/repos/rozkalnsandris/hermes-tech/pulls?page=2>; rel="next"`,
      },
    }),
  ]);
  const offOriginError = await captureReadError(() => offOrigin.transport.get(scope, pullRequest(), observedAt));
  assert.equal(offOriginError.code, "PAGINATION_BOUNDARY_VIOLATION");
  assert.equal(offOrigin.seen.length, 1);

  const crossRepository = scriptedTransport([
    jsonResponse([], {
      headers: {
        link: `<${GITHUB_REST_ORIGIN}/repos/rozkalnsandris/hermes-deals/pulls?page=2>; rel="next"`,
      },
    }),
  ]);
  const crossRepositoryError = await captureReadError(() =>
    crossRepository.transport.get(scope, pullRequest(), observedAt),
  );
  assert.equal(crossRepositoryError.code, "PAGINATION_BOUNDARY_VIOLATION");
  assert.equal(crossRepository.seen.length, 1);
});

test("rejects pagination cycles before repeating a request", async () => {
  const { transport, seen } = scriptedTransport([
    jsonResponse([], {
      headers: {
        link: `<${GITHUB_REST_ORIGIN}/repos/rozkalnsandris/hermes-tech/pulls?per_page=1&page=2>; rel="next"`,
      },
    }),
    jsonResponse([], {
      headers: {
        link: `<${GITHUB_REST_ORIGIN}/repos/rozkalnsandris/hermes-tech/pulls?per_page=1&page=1>; rel="next"`,
      },
    }),
  ]);

  const error = await captureReadError(() =>
    transport.get(
      scope,
      pullRequest("/repos/rozkalnsandris/hermes-tech/pulls?per_page=1&page=1"),
      observedAt,
    ),
  );

  assert.equal(error.code, "PAGINATION_CYCLE");
  assert.equal(seen.length, 2);
});

test("fails closed when the pagination request budget is exhausted", async () => {
  const { transport, seen } = scriptedTransport(
    [
      jsonResponse([], {
        headers: {
          link: `<${GITHUB_REST_ORIGIN}/repos/rozkalnsandris/hermes-tech/pulls?page=2>; rel="next"`,
        },
      }),
      jsonResponse([], {
        headers: {
          link: `<${GITHUB_REST_ORIGIN}/repos/rozkalnsandris/hermes-tech/pulls?page=3>; rel="next"`,
        },
      }),
    ],
    { maxRequests: 2 },
  );

  const error = await captureReadError(() => transport.get(scope, pullRequest(), observedAt));
  assert.equal(error.code, "PAGINATION_BUDGET_EXHAUSTED");
  assert.equal(seen.length, 2);
});

test("revalidates canonical repository boundary before any credential session is used", async () => {
  let sessionRequested = false;
  const transport = createGitHubRestReadTransport(async () => {
    sessionRequested = true;
    return {
      credentialLease: lease,
      execute: async () => jsonResponse({}),
    };
  });

  const forged = {
    ...pullRequest(),
    path: "/repos/rozkalnsandris/hermes-tech/%2e%2e/hermes-deals/pulls",
  };
  const error = await captureReadError(() => transport.get(scope, forged, observedAt));

  assert.equal(error.code, "PAGINATION_BOUNDARY_VIOLATION");
  assert.equal(sessionRequested, false);
});

test("classifies unauthorized, ordinary forbidden and not-found responses", async () => {
  for (const [status, code] of [
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
  ] as const) {
    const { transport, seen } = scriptedTransport([new Response("", { status })]);
    const error = await captureReadError(() => transport.get(scope, pullRequest(), observedAt));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(seen.length, 1);
  }
});

test("surfaces primary rate-limit reset evidence without retrying", async () => {
  const { transport, seen } = scriptedTransport([
    new Response("", {
      status: 403,
      headers: {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-used": "5000",
        "x-ratelimit-reset": "1786435500",
        "x-ratelimit-resource": "core",
      },
    }),
  ]);

  const error = await captureReadError(() => transport.get(scope, pullRequest(), observedAt));
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.retryNotBefore, "2026-08-11T08:05:00.000Z");
  assert.equal(error.rateLimit?.remaining, 0);
  assert.equal(seen.length, 1);
});

test("surfaces retry-after for secondary 429 rate limiting without a tight retry loop", async () => {
  const { transport, seen } = scriptedTransport([
    new Response("", {
      status: 429,
      headers: {
        "retry-after": "120",
        "x-ratelimit-remaining": "42",
        "x-ratelimit-resource": "core",
      },
    }),
  ]);

  const error = await captureReadError(() => transport.get(scope, pullRequest(), observedAt));
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.retryNotBefore, "2026-08-11T07:32:00.000Z");
  assert.equal(seen.length, 1);
});

test("uses a conservative one-minute retry floor for 429 without server timing evidence", async () => {
  const { transport, seen } = scriptedTransport([new Response("", { status: 429 })]);
  const error = await captureReadError(() => transport.get(scope, pullRequest(), observedAt));

  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.retryNotBefore, "2026-08-11T07:31:00.000Z");
  assert.equal(seen.length, 1);
});

test("rejects malformed rate-limit and retry headers", async () => {
  const malformedRemaining = scriptedTransport([
    jsonResponse([], { headers: { "x-ratelimit-remaining": "many" } }),
  ]);
  assert.equal(
    (await captureReadError(() => malformedRemaining.transport.get(scope, pullRequest(), observedAt))).code,
    "MALFORMED_RESPONSE",
  );

  const malformedRetry = scriptedTransport([
    new Response("", { status: 429, headers: { "retry-after": "soon" } }),
  ]);
  assert.equal(
    (await captureReadError(() => malformedRetry.transport.get(scope, pullRequest(), observedAt))).code,
    "MALFORMED_RESPONSE",
  );
});

test("rejects malformed Link evidence, unexpected content and unexpected statuses", async () => {
  const malformedLink = scriptedTransport([jsonResponse([], { headers: { link: "not-a-link" } })]);
  assert.equal(
    (await captureReadError(() => malformedLink.transport.get(scope, pullRequest(), observedAt))).code,
    "MALFORMED_RESPONSE",
  );

  const unexpectedContent = scriptedTransport([
    new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
  ]);
  assert.equal(
    (await captureReadError(() => unexpectedContent.transport.get(scope, pullRequest(), observedAt))).code,
    "MALFORMED_RESPONSE",
  );

  const unexpectedStatus = scriptedTransport([new Response("", { status: 500 })]);
  const statusError = await captureReadError(() => unexpectedStatus.transport.get(scope, pullRequest(), observedAt));
  assert.equal(statusError.code, "UNEXPECTED_STATUS");
  assert.equal(statusError.status, 500);
});

test("wraps credential and transport failures without exposing provider error strings", async () => {
  const unavailable = createGitHubRestReadTransport(async () => {
    throw new Error("provider detail must stay internal");
  });
  const unavailableError = await captureReadError(() => unavailable.get(scope, pullRequest(), observedAt));
  assert.equal(unavailableError.code, "CREDENTIAL_UNAVAILABLE");
  assert.doesNotMatch(unavailableError.message, /provider detail/);

  const failingTransport = createGitHubRestReadTransport(async () => ({
    credentialLease: lease,
    execute: async () => {
      throw new Error("network detail must stay internal");
    },
  }));
  const transportError = await captureReadError(() => failingTransport.get(scope, pullRequest(), observedAt));
  assert.equal(transportError.code, "TRANSPORT_FAILURE");
  assert.doesNotMatch(transportError.message, /network detail/);
});
