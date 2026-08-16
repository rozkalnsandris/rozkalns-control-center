import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
const routeSource = readFileSync(resolve(process.cwd(), "src/worker/access-auth-canary-route.ts"), "utf8");
const runtimeSource = readFileSync(resolve(process.cwd(), "src/worker/access-auth-canary-runtime.ts"), "utf8");
const probeSource = readFileSync(resolve(process.cwd(), "src/worker/access-jwks-manual-fetch-probe.ts"), "utf8");
const resolverSource = readFileSync(
  resolve(process.cwd(), "src/integrations/cloudflare/access-jwks-resolver.ts"),
  "utf8",
);

test("Phase 3 Access auth canary is wired but remains unconfigured in Wrangler", () => {
  assert.match(workerIndex, /access-auth-canary-route/);
  assert.match(workerIndex, /ACCESS_AUTH_CANARY_ROUTE_PATH/);
  assert.match(workerIndex, /handleAccessAuthCanaryRequest/);
  assert.match(workerIndex, /resolveAccessAuthCanaryRuntime/);
  assert.match(workerIndex, /resolution\.status === "READY" \? resolution\.authenticator : null/);
  assert.match(workerIndex, /resolution\.status === "READY" \? resolution\.jwksFetchProbe : null/);

  for (const binding of [
    "CONTROL_ACCESS_AUTH_CANARY_ENABLED",
    "CONTROL_ACCESS_ISSUER",
    "CONTROL_ACCESS_AUDIENCE",
    "TEAM_DOMAIN",
    "POLICY_AUD",
  ]) {
    assert.equal(wranglerConfig.includes(binding), false, `unexpected live binding: ${binding}`);
  }

  assert.match(runtimeSource, /CONTROL_ACCESS_AUTH_CANARY_ENABLED/);
  assert.match(runtimeSource, /CONTROL_ACCESS_ISSUER/);
  assert.match(runtimeSource, /CONTROL_ACCESS_AUDIENCE/);
  assert.match(runtimeSource, /AccessJwksManualFetchProbe/);
  assert.match(runtimeSource, /INVALID_CONFIGURATION/);
  assert.doesNotMatch(runtimeSource, /console\.(log|info|warn|error)/);

  assert.match(routeSource, /ACCESS_AUTHENTICATION_FAILED/);
  assert.match(routeSource, /ACCESS_JWKS_FETCH_TYPE_ERROR/);
  assert.match(routeSource, /jwksFetchProbe/);
  assert.match(routeSource, /AUTHENTICATED/);
  assert.doesNotMatch(routeSource, /console\.(log|info|warn|error)/);
  assert.doesNotMatch(routeSource, /GITHUB_/);
  assert.doesNotMatch(routeSource, /CONTROL_DB/);
  assert.doesNotMatch(routeSource, /RECONCILIATION_QUEUE/);

  assert.match(
    probeSource,
    /new CloudflareAccessJwksResolver\(\{ issuer: config\.issuer \}\)\.endpoint/,
  );
  assert.match(probeSource, /redirect:\s*"manual"/);
  assert.match(probeSource, /method:\s*"GET"/);
  assert.match(probeSource, /Accept:\s*"application\/json"/);
  assert.match(probeSource, /AbortSignal\.timeout\(MANUAL_PROBE_TIMEOUT_MS\)/);
  assert.doesNotMatch(probeSource, /response\.(text|json|arrayBuffer|blob|formData)\(/);
  assert.doesNotMatch(probeSource, /headers\.get\(/);
  assert.doesNotMatch(probeSource, /location/i);
  assert.doesNotMatch(probeSource, /console\.(log|info|warn|error)/);

  assert.match(resolverSource, /const ACCESS_CERTS_PATH = "\/cdn-cgi\/access\/certs"/);
  assert.match(resolverSource, /redirect:\s*"error"/);
});
