import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_CONTENTS_WRITE_PERMISSION,
  GitHubPullRequestMergeWriteError,
  createGitHubPullRequestMergeWriter,
  type GitHubAuthorizedRestPut,
  type GitHubInstallationAuthorizedMergeSessionProvider,
  type GitHubPullRequestMergeWriteScope,
} from "../src/integrations/github/pull-request-merge-write.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const HEAD = "1111111111111111111111111111111111111111";
const MERGE_SHA = "2222222222222222222222222222222222222222";
const PULL_NUMBER = 48;
const OBSERVED_AT = "2026-08-24T13:05:00+02:00";

interface Capture {
  scopes: GitHubPullRequestMergeWriteScope[];
  observedAt: string[];
  requests: GitHubAuthorizedRestPut[];
}

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ sha: MERGE_SHA, merged: true, message: "Pull Request successfully merged", ...overrides }, { status: 200 });
}

function capture(): Capture {
  return { scopes: [], observedAt: [], requests: [] };
}

function provider(
  seen: Capture,
  execute: (request: GitHubAuthorizedRestPut) => Promise<Response> = async () => successResponse(),
): GitHubInstallationAuthorizedMergeSessionProvider {
  return async (scope, observedAt) => {
    seen.scopes.push(scope);
    seen.observedAt.push(observedAt);
    return {
      async execute(request) {
        seen.requests.push(request);
        return execute(request);
      },
    };
  };
}

function request(overrides = {}) {
  return {
    repository: REPOSITORY,
    pullNumber: PULL_NUMBER,
    expectedHeadSha: HEAD,
    mergeMethod: "squash" as const,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

test("merge emits one exact-head protected GitHub PUT with explicit merge method", async () => {
  const seen = capture();
  const writer = createGitHubPullRequestMergeWriter(provider(seen));

  const result = await writer.merge(request());

  assert.deepEqual(seen.scopes, [{ repository: REPOSITORY, permission: GITHUB_CONTENTS_WRITE_PERMISSION }]);
  assert.deepEqual(seen.observedAt, ["2026-08-24T11:05:00.000Z"]);
  assert.equal(seen.requests.length, 1);
  const sent = seen.requests[0];
  assert.equal(sent.method, "PUT");
  assert.equal(sent.url, `https://api.github.com/repos/${REPOSITORY}/pulls/${PULL_NUMBER}/merge`);
  assert.equal(sent.accept, "application/vnd.github+json");
  assert.equal(sent.apiVersion, "2026-03-10");
  assert.equal(sent.contentType, "application/json");
  assert.equal(sent.redirect, "manual");
  assert.equal(sent.requiredPermission, "contents:write");
  assert.deepEqual(JSON.parse(sent.body), { sha: HEAD, merge_method: "squash" });
  assert.deepEqual(result, { merged: true, mergeSha: MERGE_SHA });
});

test("all documented merge methods remain explicit and exact-head bound", async () => {
  for (const method of ["merge", "squash", "rebase"] as const) {
    const seen = capture();
    const writer = createGitHubPullRequestMergeWriter(provider(seen));
    await writer.merge(request({ mergeMethod: method }));
    assert.deepEqual(JSON.parse(seen.requests[0].body), { sha: HEAD, merge_method: method });
  }
});

test("invalid repository, pull number, SHA, method and observation time fail before session acquisition", async () => {
  const invalid = [
    request({ repository: "rozkalnsandris/hermes-email-skill" }),
    request({ pullNumber: 0 }),
    request({ expectedHeadSha: "ABC" }),
    request({ mergeMethod: "auto" }),
    request({ observedAt: "not-a-date" }),
  ];

  for (const candidate of invalid) {
    const seen = capture();
    const writer = createGitHubPullRequestMergeWriter(provider(seen));
    await assert.rejects(
      writer.merge(candidate as Parameters<typeof writer.merge>[0]),
      (error: unknown) => error instanceof GitHubPullRequestMergeWriteError && error.code === "INVALID_REQUEST",
    );
    assert.equal(seen.scopes.length, 0);
    assert.equal(seen.requests.length, 0);
  }
});

test("session acquisition failure occurs before the Merge write", async () => {
  const writer = createGitHubPullRequestMergeWriter(async () => {
    throw new Error("credential unavailable");
  });
  await assert.rejects(
    writer.merge(request()),
    (error: unknown) => error instanceof GitHubPullRequestMergeWriteError && error.code === "CREDENTIAL_UNAVAILABLE",
  );
});

test("documented rejection statuses are bounded and never retried", async () => {
  const cases = new Map<number, string>([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [405, "MERGE_NOT_ALLOWED"],
    [409, "HEAD_CONFLICT"],
    [422, "VALIDATION_FAILED"],
    [429, "RATE_LIMITED"],
  ]);

  for (const [status, code] of cases) {
    const seen = capture();
    let calls = 0;
    const writer = createGitHubPullRequestMergeWriter(
      provider(seen, async () => {
        calls += 1;
        return new Response("do not parse this body", { status });
      }),
    );
    await assert.rejects(
      writer.merge(request()),
      (error: unknown) =>
        error instanceof GitHubPullRequestMergeWriteError && error.code === code && error.status === status,
    );
    assert.equal(calls, 1);
    assert.equal(seen.requests.length, 1);
  }
});

test("transport failure after execute begins is outcome-unknown and never auto-retries", async () => {
  const seen = capture();
  let calls = 0;
  const writer = createGitHubPullRequestMergeWriter(
    provider(seen, async () => {
      calls += 1;
      throw new Error("connection reset after request send");
    }),
  );
  await assert.rejects(
    writer.merge(request()),
    (error: unknown) => error instanceof GitHubPullRequestMergeWriteError && error.code === "WRITE_OUTCOME_UNKNOWN",
  );
  assert.equal(calls, 1);
  assert.equal(seen.requests.length, 1);
});

test("unexpected or malformed success evidence is outcome-unknown", async () => {
  const responses = [
    new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    successResponse({ merged: false }),
    successResponse({ sha: "ABC" }),
    new Response("server error", { status: 500 }),
  ];
  for (const response of responses) {
    const writer = createGitHubPullRequestMergeWriter(provider(capture(), async () => response.clone()));
    await assert.rejects(
      writer.merge(request()),
      (error: unknown) => error instanceof GitHubPullRequestMergeWriteError && error.code === "WRITE_OUTCOME_UNKNOWN",
    );
  }
});
