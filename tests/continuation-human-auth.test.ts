import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { resolveContinuationActionRuntime } from "../src/worker/continuation-action-runtime.js";
import { handleContinuationActionRequest } from "../src/worker/continuation-action-route.js";

test("real continuation runtime denies service identities before GET/POST domain or D1 work", async (t) => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issuer = "https://owner-test.cloudflareaccess.com";
  const audience = "b".repeat(64);
  const kid = "continuation-human-test";
  const now = Math.floor(Date.now() / 1000);
  let reads = 0;
  let writes = 0;
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.equal(String(input), issuer + "/cdn-cgi/access/certs");
    fetches++;
    return Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig", key_ops: ["verify"] }] });
  });
  const runtime = resolveContinuationActionRuntime({
    CONTROL_CONTINUATION_RUNTIME_ENABLED: "true",
    CONTROL_CONTINUATION_ACCESS_ISSUER: issuer,
    CONTROL_CONTINUATION_ACCESS_AUDIENCE: audience,
    GITHUB_APP_CLIENT_ID: "test-client",
    GITHUB_APP_INSTALLATION_ID: "1",
    GITHUB_APP_PRIVATE_KEY_PEM: "unused-test-key",
    CONTROL_DB: {
      prepare(): never { reads++; throw new Error("unexpected D1 read"); },
      async batch(): Promise<never> { writes++; throw new Error("unexpected D1 write"); },
    },
  });
  assert.ok(runtime);
  const token = (claims: Record<string, unknown>) => {
    const input = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url") + "." +
      Buffer.from(JSON.stringify({ type: "app", iss: issuer, aud: [audience], exp: now + 600, iat: now - 10, ...claims })).toString("base64url");
    return input + "." + sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url");
  };
  const service = token({ sub: "", common_name: "synthetic-service.access" });
  const human = token({ sub: "owner-subject", email: "owner@example.test", nbf: now - 10 });
  const missingEmail = token({ sub: "owner-subject", nbf: now - 10 });
  for (const identity of [service, missingEmail, null]) {
    for (const method of ["GET", "POST"]) {
      const url = "https://control.invalid/api/control/continuation" +
        (method === "GET" ? "/preflight?repository=rozkalnsandris%2Fops-workflows&decisionId=github%3Aops-workflows%3Apr%3A1&expectedMainSha=" + "a".repeat(40) : "");
      const response = await handleContinuationActionRequest(new Request(url, {
        method,
        headers: { "Content-Type": "application/json", ...(identity ? { "Cf-Access-Jwt-Assertion": identity } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
      }), runtime);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "ACCESS_AUTHENTICATION_FAILED" });
    }
  }
  // A signed human reaches request validation; no fake successful domain result.
  const response = await handleContinuationActionRequest(new Request("https://control.invalid/api/control/continuation/preflight", {
    headers: { "Cf-Access-Jwt-Assertion": human },
  }), runtime);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "INVALID_REQUEST" });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(fetches, 1);
});
