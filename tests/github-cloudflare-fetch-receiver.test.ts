import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubAppCredentialFetch } from "../src/integrations/github/app-installation-session.js";
import { createCloudflareGitHubCredentialFetch } from "../src/integrations/github/cloudflare-worker-runtime.js";

test("normalizes GitHub credential fetch to plain-function receiver semantics", async () => {
  const unexpectedReceiver = { source: "method-call" };
  const request = new Request("https://api.github.com/app/installations/123/access_tokens", {
    method: "POST",
  });

  let observedThis: unknown = unexpectedReceiver;
  let observedRequest: Request | undefined;
  let calls = 0;

  const receiverSensitiveFetch: GitHubAppCredentialFetch = async function (
    this: unknown,
    input: Request,
  ): Promise<Response> {
    calls += 1;
    observedThis = this;
    observedRequest = input;
    return Response.json({ ok: true });
  };

  const fetchRequest = createCloudflareGitHubCredentialFetch(receiverSensitiveFetch);
  const response = await Reflect.apply(fetchRequest, unexpectedReceiver, [request]);

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(observedThis, undefined);
  assert.equal(observedRequest, request);
});
