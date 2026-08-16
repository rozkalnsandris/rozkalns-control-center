import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudflareAccessJwksError,
  CloudflareAccessJwksResolver,
  type CloudflareAccessJwksErrorCode,
} from "../src/integrations/cloudflare/access-jwks-resolver.js";

const ISSUER = "https://rozkalns.cloudflareaccess.com";

async function rejectsSanitized(
  error: unknown,
  expectedCode: CloudflareAccessJwksErrorCode,
  forbiddenDetails: readonly string[],
): Promise<void> {
  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => {
      throw error;
    },
  });

  await assert.rejects(
    resolver.resolveSigningKey("kid-current"),
    (thrown: unknown) => {
      assert.ok(thrown instanceof CloudflareAccessJwksError);
      assert.equal(thrown.code, expectedCode);
      assert.equal(thrown.message, expectedCode);
      for (const forbiddenDetail of forbiddenDetails) {
        assert.equal(thrown.code.includes(forbiddenDetail), false);
        assert.equal(thrown.message.includes(forbiddenDetail), false);
      }
      return true;
    },
  );
}

test("classifies native timeout and abort fetch failures without reflecting runtime detail", async () => {
  await rejectsSanitized(
    new DOMException("private timeout runtime detail", "TimeoutError"),
    "ACCESS_JWKS_FETCH_TIMEOUT",
    ["private timeout runtime detail"],
  );

  await rejectsSanitized(
    new DOMException("private abort runtime detail", "AbortError"),
    "ACCESS_JWKS_FETCH_TIMEOUT",
    ["private abort runtime detail"],
  );
});

test("preserves native TypeError and generic Error behavior without reflecting runtime detail", async () => {
  await rejectsSanitized(
    new TypeError("private redirect or network runtime detail"),
    "ACCESS_JWKS_FETCH_TYPE_ERROR",
    ["private redirect or network runtime detail"],
  );

  await rejectsSanitized(
    new Error("private generic runtime detail"),
    "ACCESS_JWKS_FETCH_FAILED",
    ["private generic runtime detail"],
  );
});

test("classifies allow-listed name-only error shapes without realm-sensitive instanceof", async () => {
  const timeoutLike = { name: "TimeoutError", message: "cross-realm timeout detail" };
  assert.equal(timeoutLike instanceof DOMException, false);
  await rejectsSanitized(timeoutLike, "ACCESS_JWKS_FETCH_TIMEOUT", ["cross-realm timeout detail"]);

  const abortLike = { name: "AbortError", message: "cross-realm abort detail" };
  assert.equal(abortLike instanceof DOMException, false);
  await rejectsSanitized(abortLike, "ACCESS_JWKS_FETCH_TIMEOUT", ["cross-realm abort detail"]);

  const typeLike = { name: "TypeError", message: "cross-realm type detail" };
  assert.equal(typeLike instanceof TypeError, false);
  await rejectsSanitized(typeLike, "ACCESS_JWKS_FETCH_TYPE_ERROR", ["cross-realm type detail"]);

  const errorLike = { name: "Error", message: "cross-realm generic detail" };
  assert.equal(errorLike instanceof Error, false);
  await rejectsSanitized(errorLike, "ACCESS_JWKS_FETCH_ERROR", ["cross-realm generic detail"]);
});

test("never reflects arbitrary names or sensitive runtime fields", async () => {
  const tokenLike = "eyJhbGciOiJSUzI1NiJ9.private.jwt.material";
  const keyMaterialLike = "rsa-key-material-do-not-leak";
  const privateUrl = "https://private.example.test/certs?secret=1";
  const maliciousName = `TypeError\n${"x".repeat(4096)}\u0000${tokenLike}`;

  await rejectsSanitized(
    {
      name: maliciousName,
      message: tokenLike,
      stack: keyMaterialLike,
      url: privateUrl,
      token: tokenLike,
      key: keyMaterialLike,
    },
    "ACCESS_JWKS_FETCH_FAILED",
    [tokenLike, keyMaterialLike, privateUrl],
  );
});

test("keeps unknown and unreadable error shapes generic and sanitized", async () => {
  await rejectsSanitized(
    { message: "private object runtime detail" },
    "ACCESS_JWKS_FETCH_FAILED",
    ["private object runtime detail"],
  );

  const unreadableName = Object.defineProperty(
    { message: "private getter runtime detail" },
    "name",
    {
      get() {
        throw new Error("private getter runtime detail");
      },
    },
  );
  await rejectsSanitized(
    unreadableName,
    "ACCESS_JWKS_FETCH_FAILED",
    ["private getter runtime detail"],
  );
});
