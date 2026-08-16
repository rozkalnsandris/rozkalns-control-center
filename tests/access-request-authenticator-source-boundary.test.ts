import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
const compositionSource = readFileSync(
  resolve(process.cwd(), "src/worker/access-request-authenticator.ts"),
  "utf8",
);
const resolverSource = readFileSync(
  resolve(process.cwd(), "src/integrations/cloudflare/access-jwks-resolver.ts"),
  "utf8",
);

const retiredCanaryPaths = [
  "src/worker/access-auth-canary-route.ts",
  "src/worker/access-auth-canary-runtime.ts",
  "src/worker/access-jwks-manual-fetch-probe.ts",
  "scripts/cloudflare-access-auth-canary-plan.mjs",
  "scripts/cloudflare-access-auth-canary-gate.mjs",
] as const;

test("Phase 3 production Access auth primitives remain source-only while the completed canary surface stays retired", () => {
  assert.equal(workerIndex.includes("access-request-authenticator"), false);
  assert.equal(workerIndex.includes("CloudflareAccessRequestAuthenticator"), false);
  assert.equal(workerIndex.includes("Cf-Access-Jwt-Assertion"), false);
  assert.equal(workerIndex.includes("/api/auth/access-canary"), false);
  assert.equal(workerIndex.includes("jwksFetchProbe"), false);

  for (const path of retiredCanaryPaths) {
    assert.equal(existsSync(resolve(process.cwd(), path)), false, `retired canary path returned: ${path}`);
  }

  for (const binding of [
    "CONTROL_ACCESS_ISSUER",
    "CONTROL_ACCESS_AUDIENCE",
    "CONTROL_ACCESS_AUTH_CANARY_ENABLED",
    "TEAM_DOMAIN",
    "POLICY_AUD",
  ]) {
    assert.equal(wranglerConfig.includes(binding), false, `unexpected live binding: ${binding}`);
  }

  assert.match(compositionSource, /CloudflareAccessJwksResolver/);
  assert.match(compositionSource, /CloudflareAccessJwtVerifier/);
  assert.match(compositionSource, /authenticateRequest/);
  assert.match(compositionSource, /ACCESS_AUTHENTICATION_FAILED/);
  assert.doesNotMatch(compositionSource, /CF_Authorization/);
  assert.doesNotMatch(compositionSource, /console\.(log|info|warn|error)/);

  assert.match(resolverSource, /redirect:\s*"manual"/);
  assert.doesNotMatch(resolverSource, /redirect:\s*"follow"/);
  assert.match(resolverSource, /if \(!response\.ok\)/);
});
