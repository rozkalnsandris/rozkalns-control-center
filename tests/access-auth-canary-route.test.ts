import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_AUTH_CANARY_ROUTE_PATH,
  handleAccessAuthCanaryRequest,
  type AccessRequestAuthenticatorLike,
} from "../src/worker/access-auth-canary-route.js";

function request(path: string = ACCESS_AUTH_CANARY_ROUTE_PATH, init?: RequestInit): Request {
  return new Request(`https://control.rozkalns.net${path}`, init);
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

class StubAuthenticator implements AccessRequestAuthenticatorLike {
  readonly seen: Request[] = [];
  readonly #result: "success" | "failure";

  constructor(result: "success" | "failure" = "success") {
    this.#result = result;
  }

  async authenticateRequest(value: Request): Promise<unknown> {
    this.seen.push(value);
    if (this.#result === "failure") {
      throw new Error("secret inner auth detail: kid=do-not-leak");
    }
    return {
      subject: "principal-do-not-return",
      email: "private@example.test",
      rawToken: "jwt-do-not-return",
    };
  }
}

test("returns only a non-identity success projection after authentication", async () => {
  const authenticator = new StubAuthenticator();
  const response = await handleAccessAuthCanaryRequest(request(), authenticator);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { status: "AUTHENTICATED" });
  assert.equal(authenticator.seen.length, 1);

  for (const forbidden of ["principal-do-not-return", "private@example.test", "jwt-do-not-return"]) {
    assert.equal(body.includes(forbidden), false);
  }
});

test("rejects wrong path, method and query before authentication", async () => {
  const authenticator = new StubAuthenticator();

  const wrongPath = await handleAccessAuthCanaryRequest(request("/api/auth/other"), authenticator);
  assert.equal(wrongPath.status, 404);
  assert.deepEqual(await readJson(wrongPath), { error: "NOT_FOUND" });

  const wrongMethod = await handleAccessAuthCanaryRequest(
    request(ACCESS_AUTH_CANARY_ROUTE_PATH, { method: "POST" }),
    authenticator,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  assert.deepEqual(await readJson(wrongMethod), { error: "METHOD_NOT_ALLOWED" });

  const query = await handleAccessAuthCanaryRequest(
    request(`${ACCESS_AUTH_CANARY_ROUTE_PATH}?debug=1`),
    authenticator,
  );
  assert.equal(query.status, 400);
  assert.deepEqual(await readJson(query), { error: "INVALID_REQUEST" });

  assert.equal(authenticator.seen.length, 0);
});

test("fails closed when the canary authenticator is not configured", async () => {
  const response = await handleAccessAuthCanaryRequest(request(), null);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readJson(response), { error: "ACCESS_AUTH_CANARY_DISABLED" });
});

test("collapses every authentication failure to one generic 403 without leakage", async () => {
  const authenticator = new StubAuthenticator("failure");
  const response = await handleAccessAuthCanaryRequest(request(), authenticator);

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error: "ACCESS_AUTHENTICATION_FAILED" });

  for (const forbidden of ["secret inner auth detail", "kid=do-not-leak", "jwt", "subject", "email"]) {
    assert.equal(body.includes(forbidden), false);
  }
  assert.equal(authenticator.seen.length, 1);
});
