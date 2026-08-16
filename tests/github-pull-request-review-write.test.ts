import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
  GITHUB_REQUEST_CHANGES_EVENT,
  GitHubPullRequestReviewWriteError,
  createGitHubPullRequestReviewWriter,
  type GitHubAuthorizedRestPost,
  type GitHubInstallationAuthorizedPullRequestWriteSessionProvider,
  type GitHubPullRequestWriteScope,
} from "../src/integrations/github/pull-request-review-write.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const HEAD = "1111111111111111111111111111111111111111";
const PULL_NUMBER = 48;
const OBSERVED_AT = "2026-08-16T15:55:00+02:00";

interface Capture {
  scopes: GitHubPullRequestWriteScope[];
  observedAt: string[];
  requests: GitHubAuthorizedRestPost[];
}

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      id: 80,
      state: "CHANGES_REQUESTED",
      commit_id: HEAD,
      html_url: `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}#pullrequestreview-80`,
      submitted_at: "2026-08-16T13:55:01Z",
      ...overrides,
    },
    { status: 200 },
  );
}

function provider(
  capture: Capture,
  execute: (request: GitHubAuthorizedRestPost) => Promise<Response> = async () => successResponse(),
): GitHubInstallationAuthorizedPullRequestWriteSessionProvider {
  return async (scope, observedAt) => {
    capture.scopes.push(scope);
    capture.observedAt.push(observedAt);
    return {
      async execute(request) {
        capture.requests.push(request);
        return execute(request);
      },
    };
  };
}

function capture(): Capture {
  return { scopes: [], observedAt: [], requests: [] };
}

function request(overrides = {}) {
  return {
    repository: REPOSITORY,
    pullNumber: PULL_NUMBER,
    expectedHeadSha: HEAD,
    body: "Please address the reviewed issues before this is merged.",
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

test("requestChanges emits one bounded REQUEST_CHANGES POST for the managed repository and exact head", async () => {
  const seen = capture();
  const writer = createGitHubPullRequestReviewWriter(provider(seen));

  const result = await writer.requestChanges(request());

  assert.deepEqual(seen.scopes, [
    { repository: REPOSITORY, permission: GITHUB_PULL_REQUESTS_WRITE_PERMISSION },
  ]);
  assert.deepEqual(seen.observedAt, ["2026-08-16T13:55:00.000Z"]);
  assert.equal(seen.requests.length, 1);

  const sent = seen.requests[0];
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, `https://api.github.com/repos/${REPOSITORY}/pulls/${PULL_NUMBER}/reviews`);
  assert.equal(sent.accept, "application/vnd.github+json");
  assert.equal(sent.apiVersion, "2026-03-10");
  assert.equal(sent.contentType, "application/json");
  assert.equal(sent.redirect, "manual");
  assert.equal(sent.requiredPermission, "pull_requests:write");
  assert.deepEqual(JSON.parse(sent.body), {
    commit_id: HEAD,
    body: "Please address the reviewed issues before this is merged.",
    event: GITHUB_REQUEST_CHANGES_EVENT,
  });

  assert.deepEqual(result, {
    reviewId: "80",
    state: "CHANGES_REQUESTED",
    commitId: HEAD,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}#pullrequestreview-80`,
    submittedAt: "2026-08-16T13:55:01.000Z",
  });
});

test("invalid repository, PR number, SHA, body and observation time fail before session acquisition", async () => {
  const invalid = [
    request({ repository: "rozkalnsandris/hermes-email-skill" }),
    request({ pullNumber: 0 }),
    request({ expectedHeadSha: "ABC" }),
    request({ body: "   " }),
    request({ body: "x".repeat(4097) }),
    request({ observedAt: "not-a-date" }),
  ];

  for (const candidate of invalid) {
    const seen = capture();
    const writer = createGitHubPullRequestReviewWriter(provider(seen));
    await assert.rejects(
      writer.requestChanges(candidate),
      (error: unknown) =>
        error instanceof GitHubPullRequestReviewWriteError && error.code === "INVALID_REQUEST",
    );
    assert.equal(seen.scopes.length, 0);
    assert.equal(seen.requests.length, 0);
  }
});

test("session acquisition failure is known to occur before the write request", async () => {
  const writer = createGitHubPullRequestReviewWriter(async () => {
    throw new Error("credential unavailable");
  });

  await assert.rejects(
    writer.requestChanges(request()),
    (error: unknown) =>
      error instanceof GitHubPullRequestReviewWriteError && error.code === "CREDENTIAL_UNAVAILABLE",
  );
});

test("documented rejection statuses are bounded and do not parse response bodies", async () => {
  const cases = new Map<number, string>([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [422, "VALIDATION_FAILED"],
  ]);

  for (const [status, code] of cases) {
    const seen = capture();
    const writer = createGitHubPullRequestReviewWriter(
      provider(seen, async () => new Response("do not parse this body", { status })),
    );
    await assert.rejects(
      writer.requestChanges(request()),
      (error: unknown) =>
        error instanceof GitHubPullRequestReviewWriteError && error.code === code && error.status === status,
    );
    assert.equal(seen.requests.length, 1);
  }
});

test("transport rejection after execute begins is outcome-unknown and never auto-retries", async () => {
  const seen = capture();
  let calls = 0;
  const writer = createGitHubPullRequestReviewWriter(
    provider(seen, async () => {
      calls += 1;
      throw new Error("connection reset after request send");
    }),
  );

  await assert.rejects(
    writer.requestChanges(request()),
    (error: unknown) =>
      error instanceof GitHubPullRequestReviewWriteError && error.code === "WRITE_OUTCOME_UNKNOWN",
  );
  assert.equal(calls, 1);
  assert.equal(seen.requests.length, 1);
});

test("unexpected server status is outcome-unknown rather than retryable", async () => {
  const seen = capture();
  const writer = createGitHubPullRequestReviewWriter(
    provider(seen, async () => new Response("server error", { status: 500 })),
  );

  await assert.rejects(
    writer.requestChanges(request()),
    (error: unknown) =>
      error instanceof GitHubPullRequestReviewWriteError &&
      error.code === "WRITE_OUTCOME_UNKNOWN" &&
      error.status === 500,
  );
  assert.equal(seen.requests.length, 1);
});

test("malformed 200 response is outcome-unknown because the review may already exist", async () => {
  const malformedResponses = [
    new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    Response.json({ id: 80, state: "COMMENTED", commit_id: HEAD }, { status: 200 }),
    successResponse({ commit_id: "2222222222222222222222222222222222222222" }),
    successResponse({ html_url: "https://evil.example/review/80" }),
  ];

  for (const response of malformedResponses) {
    const writer = createGitHubPullRequestReviewWriter(
      provider(capture(), async () => response.clone()),
    );
    await assert.rejects(
      writer.requestChanges(request()),
      (error: unknown) =>
        error instanceof GitHubPullRequestReviewWriteError && error.code === "WRITE_OUTCOME_UNKNOWN",
    );
  }
});
