import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const liveReadGate = "scripts/cloudflare-live-read-enable-gate.mjs";

function plan() {
  return spawnSync(process.execPath, [liveReadGate], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
}

test("live-read enable plan is credential-free and non-mutating", () => {
  const result = plan();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /SOURCE_TARGET_MODE=LIVE_READ_ONLY/);
  assert.match(result.stdout, /CURRENT_RUNTIME_MODE=FIXTURE_ONLY_REQUIRED/);
  assert.match(result.stdout, /GITHUB_MUTATION=DISABLED/);
  assert.match(result.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(result.stdout, /PUBLIC_ROUTING_CHANGE=NO/);
  assert.match(result.stdout, /NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES/);
  assert.match(
    result.stdout,
    /OWNER_AUTHORIZATION_FORMAT=authorize Phase 2 Cloudflare live read control\.rozkalns\.net .* version <current-version-id> deployment <current-deployment-id> domain <domain-id>/,
  );
});

test("source target is live read-only while existing fixture redeploy remains fail-closed", async () => {
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const liveSource = await readFile(liveReadGate, "utf8");
  const fixtureSource = await readFile("scripts/cloudflare-ui-redeploy-gate.mjs", "utf8");

  assert.equal(config.vars.CONTROL_LIVE_READ_ENABLED, "true");
  assert.match(liveSource, /CONTROL_LIVE_READ_ENABLED !== "true"/);
  assert.match(liveSource, /assertLiveSourceConfig\(\)/);
  assert.match(fixtureSource, /assertFixtureSourceConfig\(\)/);
});

test("live-read gate binds authorization to exact main, CI and current Cloudflare state", async () => {
  const source = await readFile(liveReadGate, "utf8");

  assert.match(source, /authorize Phase 2 Cloudflare live read \$\{HOSTNAME\} /);
  assert.match(source, /--expected-current-version-id/);
  assert.match(source, /--expected-current-deployment-id/);
  assert.match(source, /--expected-domain-id/);
  assert.match(source, /assertRepo\(args\.sha\)/);
  assert.match(source, /assertCi\(args\.sha, args\.ci\)/);
  assert.match(source, /assertExpectedActive\(apiToken, args\.currentVersion, args\.currentDeployment, false, "PREWRITE"\)/);
  assert.match(source, /assertFixturePublicCanary\("PREWRITE"\)/);
  assert.match(source, /FINAL_PREWRITE_VERSION_SET_CHANGED/);
});

test("live-read gate has one strict deploy and no independent routing, secret or D1 write", async () => {
  const source = await readFile(liveReadGate, "utf8");

  assert.match(source, /childEnvironment\(apiToken\)/);
  assert.match(source, /"deploy",\s*\n\s*"--name"/);
  assert.match(source, /"--strict"/);
  assert.match(source, /"--experimental-provision=false"/);
  assert.match(source, /"--experimental-auto-create=false"/);
  assert.match(source, /"--install-skills=false"/);
  assert.doesNotMatch(source, /cfWrite/);
  assert.doesNotMatch(source, /d1 migrations apply/i);
  assert.doesNotMatch(source, /secret (?:put|delete|bulk)/i);

  const marker = source.indexOf('console.log("DEPLOY_STARTED=YES")');
  const deploy = source.indexOf('"deploy",', marker);
  assert.ok(marker >= 0 && deploy > marker);
  assert.match(source, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(source, /POST_DEPLOY_STATE=REVIEW_REQUIRED/);
});

test("postverify proves live binding, exact domain and read-only end-to-end dashboard canary", async () => {
  const source = await readFile(liveReadGate, "utf8");

  assert.match(source, /assertVersionBindings\(await versionDetail\(apiToken, newVersionId\), true, "POST_VERIFY"\)/);
  assert.match(source, /assertExactDomain\(apiToken, args\.domainId, "POST_VERIFY"\)/);
  assert.match(source, /assertLivePublicCanary\("POST_VERIFY"\)/);
  assert.match(source, /repositories\).*MANAGED_REPOSITORIES/s);
  assert.match(source, /workflowState === "MERGE_READY"/);
  assert.match(source, /action !== "OPEN_PR"/);
  assert.match(source, /LIVE_READ_ENABLE_GATE=PASS/);
  assert.match(source, /PUBLIC_UI_MODE=LIVE_READ_ONLY/);
  assert.match(source, /GITHUB_MUTATION=DISABLED/);
});

test("apply fails before network when privileged account input is absent", () => {
  const result = spawnSync(
    process.execPath,
    [
      liveReadGate,
      "--mode",
      "apply",
      "--expected-sha",
      "0".repeat(40),
      "--expected-ci-run-id",
      "1",
      "--expected-current-version-id",
      "00000000-0000-0000-0000-000000000000",
      "--expected-current-deployment-id",
      "11111111-1111-1111-1111-111111111111",
      "--expected-domain-id",
      "a".repeat(40),
    ],
    { cwd: process.cwd(), encoding: "utf8", env: {} },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ACCOUNT_ID_INVALID/);
  assert.doesNotMatch(result.stderr, /Bearer|PRIVATE KEY|ghs_/);
});
