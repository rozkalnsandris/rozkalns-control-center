import assert from "node:assert/strict";
import test from "node:test";

import {
  AccessJwksManualFetchProbe,
  type AccessJwksManualFetchProbeResult,
} from "../src/worker/access-jwks-manual-fetch-probe.js";
import type { CloudflareAccessJwksFetch } from "../src/integrations/cloudflare/access-jwks-resolver.js";

const ISSUER = "https://control-test.cloudflareaccess.com";
const ENDPOINT = `${ISSUER}/cdn-cgi/access/certs`;

async function resultForResponse(status: number): Promise<AccessJwksManualFetchProbeResult> {
  const probe = new AccessJwksManualFetchProbe({
    issuer: ISSUER,
    fetch: async () => new Response(null, { status }),
  });
  return probe.probe();
}

test("manual JWKS probe uses the exact endpoint and bounded manual redirect contract", async () => {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const fetch: CloudflareAccessJwksFetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(null, { status: 200 });
  };

  const probe = new AccessJwksManualFetchProbe({ issuer: ISSUER, fetch });
  assert.equal(await probe.probe(), "JWKS_MANUAL_HTTP_200");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, ENDPOINT);
  assert.equal(calls[0]?.init.method, "GET");
  assert.deepEqual(calls[0]?.init.headers, { Accept: "application/json" });
  assert.equal(calls[0]?.init.redirect, "manual");
  assert.ok(calls[0]?.init.signal instanceof AbortSignal);
  assert.equal(calls[0]?.init.signal?.aborted, false);
});

test("manual JWKS probe projects only bounded HTTP status classes", async () => {
  assert.equal(await resultForResponse(200), "JWKS_MANUAL_HTTP_200");
  assert.equal(await resultForResponse(301), "JWKS_MANUAL_HTTP_3XX");
  assert.equal(await resultForResponse(399), "JWKS_MANUAL_HTTP_3XX");
  assert.equal(await resultForResponse(403), "JWKS_MANUAL_HTTP_OTHER");
  assert.equal(await resultForResponse(503), "JWKS_MANUAL_HTTP_OTHER");
});

test("manual JWKS probe projects timeout, TypeError and unknown failures without reflecting runtime detail", async () => {
  const cases: Array<{ error: unknown; expected: AccessJwksManualFetchProbeResult }> = [
    {
      error: new DOMException("private timeout detail", "TimeoutError"),
      expected: "JWKS_MANUAL_FETCH_TIMEOUT",
    },
    {
      error: new DOMException("private abort detail", "AbortError"),
      expected: "JWKS_MANUAL_FETCH_TIMEOUT",
    },
    {
      error: new TypeError("private redirect or network detail"),
      expected: "JWKS_MANUAL_FETCH_TYPE_ERROR",
    },
    {
      error: { name: "TypeError", message: "cross-realm private detail" },
      expected: "JWKS_MANUAL_FETCH_TYPE_ERROR",
    },
    {
      error: new Error("private generic runtime detail"),
      expected: "JWKS_MANUAL_FETCH_FAILED",
    },
  ];

  for (const { error, expected } of cases) {
    const probe = new AccessJwksManualFetchProbe({
      issuer: ISSUER,
      fetch: async () => {
        throw error;
      },
    });
    const result = await probe.probe();
    assert.equal(result, expected);
    for (const forbidden of ["private", "redirect", "network", "runtime", "cross-realm"]) {
      assert.equal(result.toLowerCase().includes(forbidden), false);
    }
  }
});

test("manual JWKS probe fails closed on hostile error shapes", async () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("private getter detail");
      },
      getPrototypeOf() {
        throw new Error("private prototype detail");
      },
    },
  );

  const probe = new AccessJwksManualFetchProbe({
    issuer: ISSUER,
    fetch: async () => {
      throw hostile;
    },
  });

  assert.equal(await probe.probe(), "JWKS_MANUAL_FETCH_FAILED");
});
