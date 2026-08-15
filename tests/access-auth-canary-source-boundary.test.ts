import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
const routeSource = readFileSync(resolve(process.cwd(), "src/worker/access-auth-canary-route.ts"), "utf8");

test("Phase 3 Access auth canary route remains disconnected from live Worker configuration", () => {
  assert.equal(workerIndex.includes("access-auth-canary-route"), false);
  assert.equal(workerIndex.includes("ACCESS_AUTH_CANARY_ROUTE_PATH"), false);
  assert.equal(workerIndex.includes("handleAccessAuthCanaryRequest"), false);
  assert.equal(workerIndex.includes("/api/auth/access-canary"), false);

  for (const binding of [
    "CONTROL_ACCESS_ISSUER",
    "CONTROL_ACCESS_AUDIENCE",
    "TEAM_DOMAIN",
    "POLICY_AUD",
  ]) {
    assert.equal(wranglerConfig.includes(binding), false, `unexpected live binding: ${binding}`);
  }

  assert.match(routeSource, /ACCESS_AUTHENTICATION_FAILED/);
  assert.match(routeSource, /ACCESS_AUTH_CANARY_DISABLED/);
  assert.match(routeSource, /AUTHENTICATED/);
  assert.doesNotMatch(routeSource, /console\.(log|info|warn|error)/);
  assert.doesNotMatch(routeSource, /GITHUB_/);
  assert.doesNotMatch(routeSource, /CONTROL_DB/);
  assert.doesNotMatch(routeSource, /RECONCILIATION_QUEUE/);
});
