import assert from "node:assert/strict";
import test from "node:test";

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

test("enabled runtime constructs only the reviewed Access request authenticator", () => {
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
});
