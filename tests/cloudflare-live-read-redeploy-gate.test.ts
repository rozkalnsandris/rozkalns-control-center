import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gate = "scripts/cloudflare-live-read-redeploy-gate.mjs";
const accountId = "70e29dbca0e8363358659102d2b74178";
const diagnosticHead = "e06eb5ccc3eb68fb49c1b12e6d28a06d699c16fe";

function plan() {
  return spawnSync(process.execPath, [gate], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
}

function diagnosticArgs() {
  return [
    "--diagnostic-issue",
    "19",
    "--diagnostic-pull",
    "658",
    "--diagnostic-head-sha",
    diagnosticHead,
  ];
}

test("live-read redeploy plan is credential-free, state-specific and non-mutating", () => {
  const result = plan();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /DIAGNOSTIC_REPOSITORY=rozkalnsandris\/hermes-deals/);
  assert.match(result.stdout, /SOURCE_TARGET_MODE=LIVE_READ_ONLY/);
  assert.match(result.stdout, /CURRENT_RUNTIME_MODE=LIVE_READ_ONLY_REQUIRED/);
  assert.match(result.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(result.stdout, /WORKER_REDEPLOY=NOT_EXECUTED_IN_PLAN/);
  assert.match(result.stdout, /PREWRITE_ACCESS_CANARY=HEALTH_ROUTE/);
  assert.match(result.stdout, /PREWRITE_DIAGNOSTIC_TARGET=PUBLIC_GITHUB_OPEN_ISSUE_AND_PULL/);
  assert.match(result.stdout, /POSTVERIFY_ACCESS_CANARY=SANITIZED_RECONCILE_ROUTE/);
  assert.match(result.stdout, /LIVE_DASHBOARD_RECOVERY_REQUIRED=NO_DIAGNOSTIC_ONLY/);
  assert.match(result.stdout, /NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES/);
  assert.match(
    result.stdout,
    /OWNER_AUTHORIZATION_FORMAT=authorize Phase 2 Cloudflare live read diagnostic redeploy control\.rozkalns\.net .* version <current-version-id> deployment <current-deployment-id> domain <domain-id> diagnostic issue <issue-number> pull <pull-number> head <pull-head-sha>/,
  );
});

test("maintenance gate preserves live-read source and current-runtime state", async () => {
  const source = await readFile(gate, "utf8");
  const activation = await readFile("scripts/cloudflare-live-read-enable-gate.mjs", "utf8");
  const fixtureRedeploy = await readFile("scripts/cloudflare-ui-redeploy-gate.mjs", "utf8");

  assert.match(source, /CONTROL_LIVE_READ_ENABLED !== "true"/);
  assert.match(source, /assertExpectedActiveLive\(apiToken, args\.currentVersion, args\.currentDeployment, "PREWRITE"\)/);
  assert.match(source, /assertExpectedActiveLive\(apiToken, args\.currentVersion, args\.currentDeployment, "FINAL_PREWRITE"\)/);
  assert.match(source, /assertPlainTextBinding\(detail, "CONTROL_LIVE_READ_ENABLED", "true", codePrefix\)/);
  assert.match(activation, /assertExpectedActive\(apiToken, args\.currentVersion, args\.currentDeployment, false, "PREWRITE"\)/);
  assert.match(fixtureRedeploy, /assertFixtureSourceConfig\(\)/);
});

test("redeploy authorization binds exact Cloudflare state and fresh diagnostic target", async () => {
  const source = await readFile(gate, "utf8");

  assert.match(source, /authorize Phase 2 Cloudflare live read diagnostic redeploy \$\{HOSTNAME\} /);
  assert.match(source, /--expected-current-version-id/);
  assert.match(source, /--expected-current-deployment-id/);
  assert.match(source, /--expected-domain-id/);
  assert.match(source, /--diagnostic-issue/);
  assert.match(source, /--diagnostic-pull/);
  assert.match(source, /--diagnostic-head-sha/);
  assert.match(source, /diagnostic issue \$\{diagnostic\.issueNumber\}/);
  assert.match(source, /pull \$\{diagnostic\.pullNumber\} head \$\{diagnostic\.headSha\}/);
  assert.match(source, /assertRepo\(args\.sha\)/);
  assert.match(source, /assertCi\(args\.sha, args\.ci\)/);
  assert.match(source, /assertDiagnosticTargetCurrent\(args, "PREWRITE"\)/);
  assert.match(source, /assertDiagnosticTargetCurrent\(args, "FINAL_PREWRITE"\)/);
  assert.match(source, /process\.env\.CONTROL_ACCESS_TOKEN/);
  assert.match(source, /"cf-access-token": accessToken/);
  assert.match(source, /delete env\.CONTROL_ACCESS_TOKEN/);
  assert.match(source, /sanitizedChildEnvironment\(apiToken\)/);
  assert.doesNotMatch(source, /CF-Access-Client-Secret|CF-Access-Client-Id|Service Auth|bypass/i);
});

test("diagnostic target is fresh-read from public GitHub and stale PR hard-coding is forbidden", async () => {
  const source = await readFile(gate, "utf8");

  assert.match(source, /DIAGNOSTIC_REPOSITORY = "rozkalnsandris\/hermes-deals"/);
  assert.match(source, /https:\/\/api\.github\.com\/repos\/\$\{DIAGNOSTIC_REPOSITORY\}/);
  assert.match(source, /"X-GitHub-Api-Version": GITHUB_API_VERSION/);
  assert.match(source, /issue\?\.state !== "open"/);
  assert.match(source, /pull\?\.state !== "open"/);
  assert.match(source, /pull\?\.head\?\.sha !== target\.headSha/);
  assert.match(source, /pull\?\.base\?\.repo\?\.full_name !== DIAGNOSTIC_REPOSITORY/);
  assert.match(source, /pull\?\.head\?\.repo\?\.full_name !== DIAGNOSTIC_REPOSITORY/);
  assert.doesNotMatch(source, /pull=657/);
  assert.doesNotMatch(source, /issue=19&pull=/);
});

test("prewrite uses health plus target freshness and postverify requires bounded reconciliation identity", async () => {
  const source = await readFile(gate, "utf8");

  assert.match(source, /assertHealthCanary\("PREWRITE", accessToken\)/);
  assert.match(source, /assertHealthCanary\("FINAL_PREWRITE", accessToken\)/);
  assert.match(source, /assertHealthCanary\("POST_VERIFY", accessToken\)/);
  assert.match(source, /assertDiagnosticTargetCurrent\(args, "POST_VERIFY_TARGET"\)/);
  assert.match(source, /diagnosticPath\(target\)/);
  assert.match(source, /body\?\.repository !== target\.repository/);
  assert.match(source, /body\?\.issueNumber !== target\.issueNumber/);
  assert.match(source, /body\?\.pullNumber !== target\.pullNumber/);
  assert.match(source, /cache-control/);
  assert.match(source, /GITHUB_CREDENTIAL_UNAVAILABLE/);
  assert.match(source, /GITHUB_CREDENTIAL_UNUSABLE/);
  assert.match(source, /GITHUB_UNAUTHORIZED/);
  assert.match(source, /GITHUB_FORBIDDEN/);
  assert.match(source, /GITHUB_RATE_LIMITED/);
  assert.match(source, /GITHUB_RESPONSE_INVALID/);
  assert.match(source, /GITHUB_GRAPHQL_FAILED/);
  assert.match(source, /EVIDENCE_INVALID/);
  assert.match(source, /ISSUE_NOT_FOUND/);
  assert.match(source, /!DIAGNOSTIC_ERROR_CODES\.has\(errorCode\)/);
  assert.match(source, /SANITIZED_DIAGNOSTIC_RESULT=\$\{diagnosticResult\}/);
  assert.match(source, /DIAGNOSTIC_HEAD_SHA=\$\{diagnostic\.headSha\}/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(?:body|accessToken|apiToken)/);
});

test("gate has one strict deploy after authorization-consumption marker and no independent privileged writes", async () => {
  const source = await readFile(gate, "utf8");

  const deployMatches = source.match(/"deploy",/g) ?? [];
  assert.equal(deployMatches.length, 1);
  assert.match(source, /"--strict"/);
  assert.match(source, /"--experimental-provision=false"/);
  assert.match(source, /"--experimental-auto-create=false"/);
  assert.match(source, /"--install-skills=false"/);
  assert.doesNotMatch(source, /cfWrite|d1 migrations apply|secret (?:put|delete|bulk)/i);

  const marker = source.indexOf('console.log("DEPLOY_STARTED=YES")');
  const finalFreshness = source.indexOf('assertDiagnosticTargetCurrent(args, "FINAL_PREWRITE")');
  const deploy = source.indexOf('"deploy",', marker);
  assert.ok(finalFreshness >= 0 && marker > finalFreshness && deploy > marker);
  assert.match(source, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(source, /POST_DEPLOY_STATE=REVIEW_REQUIRED/);
  assert.match(source, /LIVE_READ_REDEPLOY_GATE=PASS/);
});

test("apply fails before network when privileged account input is absent", () => {
  const result = spawnSync(
    process.execPath,
    [
      gate,
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
      "opaque-domain-id",
      ...diagnosticArgs(),
    ],
    { cwd: process.cwd(), encoding: "utf8", env: {} },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ACCOUNT_ID_INVALID/);
  assert.doesNotMatch(result.stderr, /Bearer|PRIVATE KEY|ghs_/);
});

test("apply validates opaque domain id before privileged network use", () => {
  const result = spawnSync(
    process.execPath,
    [
      gate,
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
      "",
      ...diagnosticArgs(),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { CLOUDFLARE_ACCOUNT_ID: accountId },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DOMAIN_ID_INVALID/);
});

test("apply rejects an unbound diagnostic head before privileged network use", () => {
  const result = spawnSync(
    process.execPath,
    [
      gate,
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
      "opaque-domain-id",
      "--diagnostic-issue",
      "19",
      "--diagnostic-pull",
      "658",
      "--diagnostic-head-sha",
      "not-a-sha",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { CLOUDFLARE_ACCOUNT_ID: accountId },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DIAGNOSTIC_HEAD_INVALID/);
  assert.doesNotMatch(result.stderr, /Bearer|PRIVATE KEY|ghs_/);
});
