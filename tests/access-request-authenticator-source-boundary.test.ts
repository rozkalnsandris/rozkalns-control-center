import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
const compositionSource = readFileSync(
  resolve(process.cwd(), "src/worker/access-request-authenticator.ts"),
  "utf8",
);

test("Phase 3 Access authentication composition remains source-only and is not wired into the Worker", () => {
  assert.equal(workerIndex.includes("access-request-authenticator"), false);
  assert.equal(workerIndex.includes("CloudflareAccessRequestAuthenticator"), false);
  assert.equal(workerIndex.includes("Cf-Access-Jwt-Assertion"), false);

  for (const binding of [
    "CONTROL_ACCESS_ISSUER",
    "CONTROL_ACCESS_AUDIENCE",
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
});
