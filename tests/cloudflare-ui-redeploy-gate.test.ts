import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const redeployGate = "scripts/cloudflare-ui-redeploy-gate.mjs";

function plan() {
  return spawnSync(process.execPath, [redeployGate], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
}

test("existing-domain redeploy plan is credential-free and non-mutating", () => {
  const result = plan();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /CUSTOM_DOMAIN=control\.rozkalns\.net/);
  assert.match(result.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(result.stdout, /WORKER_REDEPLOY=NOT_EXECUTED_IN_PLAN/);
  assert.match(result.stdout, /PUBLIC_ROUTING_CHANGE=NO/);
  assert.match(result.stdout, /CUSTOM_DOMAIN=EXACT_EXISTING_DOMAIN_REQUIRED/);
  assert.match(result.stdout, /CREDENTIAL_MODEL=SINGLE_TEMPORARY_SETUP_TOKEN/);
  assert.match(result.stdout, /NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES/);
  assert.match(
    result.stdout,
    /OWNER_AUTHORIZATION_FORMAT=authorize Phase 2 Cloudflare UI redeploy control\.rozkalns\.net .* version <current-version-id> deployment <current-deployment-id> domain <domain-id>/,
  );
});

test("redeploy gate is exact-main, exact-CI and exact-current-Cloudflare-state bound", async () => {
  const source = await readFile(redeployGate, "utf8");

  assert.match(source, /authorize Phase 2 Cloudflare UI redeploy \$\{HOSTNAME\} /);
  assert.match(source, /--expected-current-version-id/);
  assert.match(source, /--expected-current-deployment-id/);
  assert.match(source, /--expected-domain-id/);
  assert.match(source, /assertRepo\(args\.sha\)/);
  assert.match(source, /assertCi\(args\.sha, args\.ci\)/);
  assert.match(source, /assertFixtureSourceConfig\(\)/);
  assert.match(source, /assertExpectedActive\(apiToken, args\.currentVersion, args\.currentDeployment, "PREWRITE"\)/);
  assert.match(source, /assertExactDomain\(apiToken, args\.domainId, "PREWRITE"\)/);
  assert.match(source, /FINAL_PREWRITE_VERSION_SET_CHANGED/);
});

test("redeploy has one strict Worker deploy and no routing or D1 write", async () => {
  const source = await readFile(redeployGate, "utf8");

  assert.match(source, /childEnvironment\(apiToken\)/);
  assert.match(source, /"deploy",\s*\n\s*"--name"/);
  assert.match(source, /"--strict"/);
  assert.match(source, /"--experimental-provision=false"/);
  assert.match(source, /"--experimental-auto-create=false"/);
  assert.match(source, /"--install-skills=false"/);
  assert.doesNotMatch(source, /cfWrite/);
  assert.doesNotMatch(source, /\/workers\/domains",\s*"(?:PUT|DELETE)"/);
  assert.doesNotMatch(source, /d1 migrations apply/i);
  assert.doesNotMatch(source, /secret (?:put|delete|bulk)/i);

  const marker = source.indexOf('console.log("DEPLOY_STARTED=YES")');
  const write = source.indexOf('"deploy",', marker);
  assert.ok(marker >= 0 && write > marker);
  assert.match(source, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(source, /POST_DEPLOY_STATE=REVIEW_REQUIRED/);
});

test("redeploy postverify proves a new 100 percent active version and preserves exact domain", async () => {
  const source = await readFile(redeployGate, "utf8");

  assert.match(source, /newVersions\.length !== 1/);
  assert.match(source, /active\.versionId !== newVersionId/);
  assert.match(source, /active\.deploymentId === args\.currentDeployment/);
  assert.match(source, /assertRequiredBindings/);
  assert.match(source, /assertSubdomainDisabled/);
  assert.match(source, /assertExactDomain\(apiToken, args\.domainId, "POST_VERIFY"\)/);
  assert.match(source, /UI_REDEPLOY_GATE=PASS/);
  assert.match(source, /PUBLIC_ROUTING_CHANGE=NO_EXISTING_DOMAIN_PRESERVED/);
});

test("apply fails before network when privileged account input is absent", () => {
  const result = spawnSync(
    process.execPath,
    [
      redeployGate,
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
