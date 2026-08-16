import assert from "node:assert/strict";
import test from "node:test";

import type {
  AccessJwksManualFetchProbeLike,
  AccessJwksManualFetchProbeResult,
} from "../src/worker/access-jwks-manual-fetch-probe.js";
import {
  ACCESS_AUTH_CANARY_ROUTE_PATH,
  handleAccessAuthCanaryRequest,
  type AccessRequestAuthenticatorLike,
} from "../src/worker/access-auth-canary-route.js";
import { CloudflareAccessAuthenticationError } from "../src/worker/access-request-authenticator.js";

function request(path: string = ACCESS_AUTH_CANARY_ROUTE_PATH, init?: RequestInit): Request {
  return new Request(`https://control.rozkalns.net${path}`, init);
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

class StubAuthenticator implements AccessRequestAuthenticatorLike {
  readonly seen: Request[] = [];
  readonly #result: "success" | "failure" | "classified-failure" | "jwks-type-error";

  constructor(
    result: "success" | "failure" | "classified-failure" | "jwks-type-error" = "success",
  ) {
    this.#result = result;
  }

  async authenticateRequest(value: Request): Promise<unknown> {
    this.seen.push(value);
    if (this.#result === "failure") {
      throw new Error("secret inner auth detail: kid=do-not-leak");
    }
    if (this.#result === "classified-failure") {
      throw new CloudflareAccessAuthenticationError("ACCESS_JWT_MISSING");
    }
    if (this.#result === "jwks-type-error") {
      throw new CloudflareAccessAuthenticationError("ACCESS_JWKS_FETCH_TYPE_ERROR");
    }
    return {
      subject: "principal-do-not-return",
      email: "private@example.test",
      rawToken: "jwt-do-not-return",
    };
  }
}

class StubProbe implements AccessJwksManualFetchProbeLike {
  calls = 0;
  readonly #result: AccessJwksManualFetchProbeResult | Error;

  constructor(result: AccessJwksManualFetchProbeResult | Error) {
    this.#result = result;
  }

  async probe(): Promise<AccessJwksManualFetchProbeResult> {
    this.calls += 1;
    if (this.#result instanceof Error) throw this.#result;
    return this.#result;
  }
}

test("returns only a non-identity success projection after authentication", async () => {
  const authenticator = new StubAuthenticator();
  const probe = new StubProbe("JWKS_MANUAL_HTTP_200");
  const response = await handleAccessAuthCanaryRequest(request(), authenticator, probe);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { status: "AUTHENTICATED" });
  assert.equal(authenticator.seen.length, 1);
  assert.equal(probe.calls, 0);

  for (const forbidden of ["principal-do-not-return", "private@example.test", "jwt-do-not-return"]) {
    assert.equal(body.includes(forbidden), false);
  }
});

test("rejects wrong path, method and query before authentication or probing", async () => {
  const authenticator = new StubAuthenticator();
  const probe = new StubProbe("JWKS_MANUAL_HTTP_200");

  const wrongPath = await handleAccessAuthCanaryRequest(request("/api/auth/other"), authenticator, probe);
  assert.equal(wrongPath.status, 404);
  assert.deepEqual(await readJson(wrongPath), { error: "NOT_FOUND" });

  const wrongMethod = await handleAccessAuthCanaryRequest(
    request(ACCESS_AUTH_CANARY_ROUTE_PATH, { method: "POST" }),
    authenticator,
    probe,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  assert.deepEqual(await readJson(wrongMethod), { error: "METHOD_NOT_ALLOWED" });

  const query = await handleAccessAuthCanaryRequest(
    request(`${ACCESS_AUTH_CANARY_ROUTE_PATH}?debug=1`),
    authenticator,
    probe,
  );
  assert.equal(query.status, 400);
  assert.deepEqual(await readJson(query), { error: "INVALID_REQUEST" });

  assert.equal(authenticator.seen.length, 0);
  assert.equal(probe.calls, 0);
});

test("fails closed when the canary authenticator is not configured", async () => {
  const probe = new StubProbe("JWKS_MANUAL_HTTP_200");
  const response = await handleAccessAuthCanaryRequest(request(), null, probe);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readJson(response), { error: "ACCESS_AUTH_CANARY_DISABLED" });
  assert.equal(probe.calls, 0);
});

test("returns one bounded verifier failure class only for typed canary authentication failures", async () => {
  const authenticator = new StubAuthenticator("classified-failure");
  const probe = new StubProbe("JWKS_MANUAL_HTTP_200");
  const response = await handleAccessAuthCanaryRequest(request(), authenticator, probe);

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    error: "ACCESS_AUTHENTICATION_FAILED",
    diagnostic: "ACCESS_JWT_MISSING",
  });
  assert.equal(probe.calls, 0);

  for (const forbidden of [
    "kid=do-not-leak",
    "jwt-do-not-return",
    "token-do-not-return",
    "subject",
    "email",
    "principal-do-not-return",
    "private@example.test",
  ]) {
    assert.equal(body.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
});

test("runs the bounded manual JWKS probe only for the typed JWKS fetch TypeError", async () => {
  const authenticator = new StubAuthenticator("jwks-type-error");
  const probe = new StubProbe("JWKS_MANUAL_HTTP_3XX");
  const response = await handleAccessAuthCanaryRequest(request(), authenticator, probe);

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readJson(response), {
    error: "ACCESS_AUTHENTICATION_FAILED",
    diagnostic: "ACCESS_JWKS_FETCH_TYPE_ERROR",
    jwksFetchProbe: "JWKS_MANUAL_HTTP_3XX",
  });
  assert.equal(probe.calls, 1);
});

test("fails the manual probe projection closed without reflecting probe exceptions", async () => {
  const authenticator = new StubAuthenticator("jwks-type-error");
  const probe = new StubProbe(new Error("private probe error: location=https://do-not-return.test"));
  const response = await handleAccessAuthCanaryRequest(request(), authenticator, probe);

  assert.equal(response.status, 403);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    error: "ACCESS_AUTHENTICATION_FAILED",
    diagnostic: "ACCESS_JWKS_FETCH_TYPE_ERROR",
    jwksFetchProbe: "JWKS_MANUAL_FETCH_FAILED",
  });
  assert.equal(probe.calls, 1);
  for (const forbidden of ["private", "location", "do-not-return", "https://"]) {
    assert.equal(body.toLowerCase().includes(forbidden), false);
  }
});

test("returns a bounded JWKS failure code without probing other JWKS classes", async () => {
  const authenticator: AccessRequestAuthenticatorLike = {
    async authenticateRequest() {
      throw new CloudflareAccessAuthenticationError("ACCESS_JWKS_FETCH_FAILED");
    },
  };
  const probe = new StubProbe("JWKS_MANUAL_HTTP_200");

  const response = await handleAccessAuthCanaryRequest(request(), authenticator, probe);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    error: "ACCESS_AUTHENTICATION_FAILED",
    diagnostic: "ACCESS_JWKS_FETCH_FAILED",
  });
  assert.equal(probe.calls, 0);

  for (const forbidden of ["kid", "token", "subject", "email", "issuer", "audience", "key material", "exception"]) {
    assert.equal(body.toLowerCase().includes(forbidden), false);
  }
});

test("keeps untyped authentication failures generic and leak-free without probing", async () => {
  const authenticator = new StubAuthenticator("failure");
  const probe = new StubProbe("JWKS_MANUAL_HTTP_200");
  const response = await handleAccessAuthCanaryRequest(request(), authenticator, probe);

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error: "ACCESS_AUTHENTICATION_FAILED" });

  for (const forbidden of ["secret inner auth detail", "kid=do-not-leak", "jwt", "subject", "email", "diagnostic"]) {
    assert.equal(body.includes(forbidden), false);
  }
  assert.equal(authenticator.seen.length, 1);
  assert.equal(probe.calls, 0);
});
