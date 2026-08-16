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
  forbiddenDetail: string,
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
      assert.equal(thrown.message.includes(forbiddenDetail), false);
      return true;
    },
  );
}

test("classifies timeout and abort fetch failures without reflecting runtime detail", async () => {
  await rejectsSanitized(
    new DOMException("private timeout runtime detail", "TimeoutError"),
    "ACCESS_JWKS_FETCH_TIMEOUT",
    "private timeout runtime detail",
  );

  await rejectsSanitized(
    new DOMException("private abort runtime detail", "AbortError"),
    "ACCESS_JWKS_FETCH_TIMEOUT",
    "private abort runtime detail",
  );
});

test("classifies fetch TypeError separately without reflecting runtime detail", async () => {
  await rejectsSanitized(
    new TypeError("private redirect or network runtime detail"),
    "ACCESS_JWKS_FETCH_TYPE_ERROR",
    "private redirect or network runtime detail",
  );
});

test("keeps all other fetch exceptions generic and sanitized", async () => {
  await rejectsSanitized(
    new Error("private generic runtime detail"),
    "ACCESS_JWKS_FETCH_FAILED",
    "private generic runtime detail",
  );

  await rejectsSanitized(
    { message: "private object runtime detail" },
    "ACCESS_JWKS_FETCH_FAILED",
    "private object runtime detail",
  );
});
