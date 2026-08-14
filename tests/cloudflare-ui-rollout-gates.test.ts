import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deployGate = "scripts/cloudflare-ui-deploy-gate.mjs";
const domainGate = "scripts/cloudflare-ui-domain-gate.mjs";
const sharedGate = "scripts/cloudflare-ui-rollout-shared.mjs";

function plan(script: string) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
}

test("first public UI rollout plan modes are credential-free and non-mutating", () => {
  const deploy = plan(deployGate);
  assert.equal(deploy.status, 0, deploy.stderr);
  assert.equal(deploy.stderr, "");
  assert.match(deploy.stdout, /MODE=PLAN/);
  assert.match(deploy.stdout, /PUBLIC_UI_MODE=FIXTURE_ONLY/);
  assert.match(deploy.stdout, /LIVE_GITHUB_RECONCILIATION=DISABLED/);
  assert.match(deploy.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(deploy.stdout, /PUBLIC_ROUTING_CHANGE=NO/);
  assert.match(deploy.stdout, /NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES/);

  const domain = plan(domainGate);
  assert.equal(domain.status, 0, domain.stderr);
  assert.equal(domain.stderr, "");
  assert.match(domain.stdout, /MODE=PLAN/);
  assert.match(domain.stdout, /CUSTOM_DOMAIN=control\.rozkalns\.net/);
  assert.match(domain.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(domain.stdout, /DOMAIN_ATTACH=NOT_EXECUTED_IN_PLAN/);
  assert.match(domain.stdout, /NO_BLIND_RETRY_AFTER_DOMAIN_ATTACH_STARTED=YES/);
});

test("production source remains fixture-only and does not declare public routing", async () => {
  const [configText, worker] = await Promise.all([
    readFile("wrangler.jsonc", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
  ]);
  const config = JSON.parse(configText) as Record<string, unknown> & {
    vars?: Record<string, string>;
  };

  assert.equal(config.vars?.CONTROL_LIVE_READ_ENABLED, "false");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  for (const forbidden of ["route", "routes", "triggers", "custom_domain", "custom_domains"]) {
    assert.equal(forbidden in config, false);
  }

  assert.match(worker, /env\.CONTROL_LIVE_READ_ENABLED !== "true"/);
  assert.match(worker, /LIVE_READ_DISABLED/);
  assert.match(worker, /status: 503/);
  assert.match(worker, /Cache-Control/);
  assert.match(worker, /secret:\s*null/);
  assert.match(worker, /acceptor:\s*null/);
});

test("deploy gate is exact-main and exact-CI bound before one strict Wrangler deploy", async () => {
  const source = await readFile(deployGate, "utf8");

  assert.match(source, /authorize Phase 2 Cloudflare non-routable UI deploy /);
  assert.match(source, /assertRepo\(args\.sha\)/);
  assert.match(source, /assertCi\(args\.sha, args\.ci\)/);
  assert.match(source, /assertFixtureSourceConfig\(\)/);
  assert.match(source, /assertHistoricalPreDeployBaseline/);
  assert.match(source, /TOKEN_SEPARATION_REQUIRED/);
  assert.match(source, /"deploy",\s*\n\s*"--name"/);
  assert.match(source, /"--strict"/);
  assert.match(source, /"--experimental-provision=false"/);
  assert.match(source, /"--experimental-auto-create=false"/);
  assert.match(source, /"--install-skills=false"/);
  assert.doesNotMatch(source, /"versions",\s*\n\s*"deploy"/);
  assert.doesNotMatch(source, /"triggers",\s*\n\s*"deploy"/);
  assert.doesNotMatch(source, /secret (?:put|delete|bulk)/i);

  const marker = source.indexOf('console.log("DEPLOY_STARTED=YES")');
  const write = source.indexOf('"deploy",', marker);
  assert.ok(marker >= 0 && write > marker);
  assert.match(source, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(source, /POST_DEPLOY_STATE=REVIEW_REQUIRED/);
});

test("deploy postverify proves one new active version, required bindings and no public route", async () => {
  const [source, shared] = await Promise.all([
    readFile(deployGate, "utf8"),
    readFile(sharedGate, "utf8"),
  ]);

  assert.match(source, /afterVersions\.length !== 3/);
  assert.match(source, /newVersions\.length !== 1/);
  assert.match(source, /active\.versionId !== newVersionId/);
  assert.match(source, /assertRequiredBindings/);
  assert.match(source, /assertSubdomainDisabled/);
  assert.match(source, /assertNoWorkerDomains/);
  assert.match(source, /UI_DEPLOY_GATE=PASS/);
  assert.match(source, /PUBLIC_ROUTING_CHANGE=NO/);

  assert.match(shared, /BOOTSTRAP_VERSION_ID = "38819190-ab13-4865-8976-7b5f7d1c1966"/);
  assert.match(shared, /SECOND_VERSION_ID = "44fb14ab-b3d4-42eb-aebb-a2612332eef6"/);
  assert.match(shared, /BASE_DEPLOYMENT_ID = "ca152e0e-295c-47a0-8637-2cd146242e74"/);
  assert.match(shared, /binding\?\.name === "CONTROL_DB"/);
  assert.match(shared, /binding\?\.type === "d1"/);
  assert.match(shared, /binding\?\.name === SECRET_NAME/);
});

test("domain gate binds exact deployed version and has one reviewed Workers-domain PUT", async () => {
  const source = await readFile(domainGate, "utf8");

  assert.match(source, /authorize Phase 2 Cloudflare UI domain \$\{HOSTNAME\} /);
  assert.match(source, /--expected-version-id/);
  assert.match(source, /assertExpectedActiveVersion/);
  assert.match(source, /TOKEN_SEPARATION_REQUIRED/);
  assert.match(source, /hostname:\s*HOSTNAME/);
  assert.match(source, /service:\s*WORKER_NAME/);
  assert.match(source, /zone_name:\s*ZONE_NAME/);
  assert.match(source, /cfWrite\(writeToken, "\/workers\/domains", "PUT"/);
  assert.doesNotMatch(source, /cfWrite\([^\n]*"DELETE"/);
  assert.doesNotMatch(source, /wranglerPath|"deploy"|"versions"/);

  const marker = source.indexOf('console.log("DOMAIN_ATTACH_STARTED=YES")');
  const write = source.indexOf('cfWrite(writeToken, "/workers/domains", "PUT"', marker);
  assert.ok(marker >= 0 && write > marker);
  assert.match(source, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(source, /POST_DOMAIN_ATTACH_STATE=REVIEW_REQUIRED/);
  assert.match(source, /UI_DOMAIN_GATE=PASS/);
});

test("package exposes only the two explicit first-UI rollout entrypoints", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.scripts?.["cf:ui-deploy-gate"], "node scripts/cloudflare-ui-deploy-gate.mjs");
  assert.equal(pkg.scripts?.["cf:ui-domain-gate"], "node scripts/cloudflare-ui-domain-gate.mjs");
});

test("apply modes fail before network when privileged inputs are absent", () => {
  const deploy = spawnSync(
    process.execPath,
    [deployGate, "--mode", "apply", "--expected-sha", "0".repeat(40), "--expected-ci-run-id", "1"],
    { cwd: process.cwd(), encoding: "utf8", env: {} },
  );
  assert.notEqual(deploy.status, 0);
  assert.match(deploy.stderr, /ACCOUNT_ID_INVALID/);

  const domain = spawnSync(
    process.execPath,
    [
      domainGate,
      "--mode",
      "apply",
      "--expected-sha",
      "0".repeat(40),
      "--expected-ci-run-id",
      "1",
      "--expected-version-id",
      "00000000-0000-0000-0000-000000000000",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: {} },
  );
  assert.notEqual(domain.status, 0);
  assert.match(domain.stderr, /ACCOUNT_ID_INVALID/);
  assert.doesNotMatch(`${deploy.stderr}\n${domain.stderr}`, /Bearer|PRIVATE KEY|ghs_/);
});
