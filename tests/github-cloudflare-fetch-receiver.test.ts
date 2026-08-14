import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubAppCredentialFetch } from "../src/integrations/github/app-installation-session.js";
import {
  GITHUB_API_USER_AGENT,
  createCloudflareGitHubCredentialFetch,
} from "../src/integrations/github/cloudflare-worker-runtime.js";

test("normalizes GitHub credential fetch to plain-function receiver semantics", async () => {
  const unexpectedReceiver = { source: "method-call" };
  const request = new Request("https://api.github.com/app/installations/123/access_tokens", {
    method: "POST",
  });

  const observedReceivers: unknown[] = [];
  let observedRequest: Request | undefined;
  let calls = 0;

  const receiverSensitiveFetch: GitHubAppCredentialFetch = async function (
    this: unknown,
    input: Request,
  ): Promise<Response> {
    calls += 1;
    observedReceivers.push(this);
    observedRequest = input;
    return Response.json({ ok: true });
  };

  const fetchRequest = createCloudflareGitHubCredentialFetch(receiverSensitiveFetch);
  const response = await Reflect.apply(fetchRequest, unexpectedReceiver, [request]);

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(observedReceivers, [undefined]);
  assert.equal(observedRequest, request);
  assert.equal(observedRequest.headers.get("user-agent"), GITHUB_API_USER_AGENT);
});

test("adds the required GitHub User-Agent to token, REST and GraphQL requests", async () => {
  const observed: Array<{ method: string; url: string; userAgent: string | null }> = [];
  const fetchImplementation: GitHubAppCredentialFetch = async (request) => {
    observed.push({
      method: request.method,
      url: request.url,
      userAgent: request.headers.get("user-agent"),
    });
    return Response.json({ ok: true });
  };
  const fetchRequest = createCloudflareGitHubCredentialFetch(fetchImplementation);

  for (const request of [
    new Request("https://api.github.com/app/installations/123/access_tokens", { method: "POST" }),
    new Request("https://api.github.com/repos/rozkalnsandris/hermes-tech/pulls/42", { method: "GET" }),
    new Request("https://api.github.com/graphql", { method: "POST" }),
  ]) {
    await fetchRequest(request);
  }

  assert.deepEqual(observed, [
    {
      method: "POST",
      url: "https://api.github.com/app/installations/123/access_tokens",
      userAgent: GITHUB_API_USER_AGENT,
    },
    {
      method: "GET",
      url: "https://api.github.com/repos/rozkalnsandris/hermes-tech/pulls/42",
      userAgent: GITHUB_API_USER_AGENT,
    },
    {
      method: "POST",
      url: "https://api.github.com/graphql",
      userAgent: GITHUB_API_USER_AGENT,
    },
  ]);
});
