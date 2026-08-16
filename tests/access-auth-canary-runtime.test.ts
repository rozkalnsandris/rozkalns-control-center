import assert from "node:assert/strict";
import test from "node:test";

import { AccessJwksManualFetchProbe } from "../src/worker/access-jwks-manual-fetch-probe.js";
import { CloudflareAccessRequestAuthenticator } from "../src/worker/access-request-authenticator.js";
import { resolveAccessAuthCanaryRuntime } from "../src/worker/access-auth-canary-runtime.js";

const VALID_ISSUER = "https://control-test.cloudflareaccess.com";
const VALID_AUDIENCE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("Access auth canary runtime is disabled unless the enable flag is exactly true", () => {
  for (const enabled of [undefined, "false", "TRUE", true, 1]) {
    const resolution = resolveAccessAuthCanaryRuntime({
      CONTROL_ACCESS_AUTH_CANARY_ENABLED: enabled,
      CONTROL_ACCESS_ISSUER: VALID_ISSUER,
      CONTROL_ACCESS_AUDIENCE: VALID_AUDIENCE,
    });

    assert.deepEqual(resolution, { status: "DISABLED", authenticator: null });
  }
});

test("enabled runtime fails closed for missing or malformed trusted configuration", () => {
  const cases = [
    {},
    { CONTROL_ACCESS_ISSUER: VALID_ISSUER },
    { CONTROL_ACCESS_AUDIENCE: VALID_AUDIENCE },
    {
      CONTROL_ACCESS_ISSUER: " http://example.com ",
      CONTROL_ACCESS_AUDIENCE: VALID_AUDIENCE,
    },
    {
      CONTROL_ACCESS_ISSUER: "https://example.com",
      CONTROL_ACCESS_AUDIENCE: VALID_AUDIENCE,
    },
    {
      CONTROL_ACCESS_ISSUER: VALID_ISSUER,
      CONTROL_ACCESS_AUDIENCE: " audience-with-spaces ",
    },
  ];

  for (const config of cases) {
    const resolution = resolveAccessAuthCanaryRuntime({
      CONTROL_ACCESS_AUTH_CANARY_ENABLED: "true",
      ...config,
    });

    assert.deepEqual(resolution, {
      status: "INVALID_CONFIGURATION",
      authenticator: null,
    });
  }
});

test("enabled runtime constructs the reviewed authenticator and canary-only manual JWKS probe", () => {
  const resolution = resolveAccessAuthCanaryRuntime({
    CONTROL_ACCESS_AUTH_CANARY_ENABLED: "true",
    CONTROL_ACCESS_ISSUER: VALID_ISSUER,
    CONTROL_ACCESS_AUDIENCE: VALID_AUDIENCE,
  });

  assert.equal(resolution.status, "READY");
  if (resolution.status !== "READY") {
    assert.fail("expected READY Access auth canary runtime");
  }
  assert.ok(resolution.authenticator instanceof CloudflareAccessRequestAuthenticator);
  assert.ok(resolution.jwksFetchProbe instanceof AccessJwksManualFetchProbe);
});

test("runtime injects the same reviewed fetch dependency into authenticator and manual probe", async () => {
  const seenRedirectModes: RequestRedirect[] = [];
  const fetch = async (_input: string, init: RequestInit): Promise<Response> => {
    if (init.redirect) seenRedirectModes.push(init.redirect);
    if (init.redirect === "manual") return new Response(null, { status: 302 });
    throw new TypeError("private resolver detail");
  };

  const resolution = resolveAccessAuthCanaryRuntime(
    {
      CONTROL_ACCESS_AUTH_CANARY_ENABLED: "true",
      CONTROL_ACCESS_ISSUER: VALID_ISSUER,
      CONTROL_ACCESS_AUDIENCE: VALID_AUDIENCE,
    },
    { fetch },
  );

  assert.equal(resolution.status, "READY");
  if (resolution.status !== "READY") assert.fail("expected READY Access auth canary runtime");

  assert.equal(await resolution.jwksFetchProbe.probe(), "JWKS_MANUAL_HTTP_3XX");
  assert.deepEqual(seenRedirectModes, ["manual"]);
});
