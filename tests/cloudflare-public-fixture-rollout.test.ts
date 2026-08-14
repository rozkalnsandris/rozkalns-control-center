import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const deployGate = "scripts/cloudflare-public-fixture-deploy-gate.mjs";
const domainGate = "scripts/cloudflare-public-fixture-domain-gate.mjs";
const common = "scripts/cloudflare-public-rollout-common.mjs";

function runPlan(script: string) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
}

test("public fixture deploy gate defaults to a non-mutating plan", () => {
  const result = runPlan(deployGate);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(result.stdout, /AUTHORIZED_APPLY=WRANGLER_DEPLOY_STRICT_EXACT_MAIN/);
  assert.match(result.stdout, /PUBLIC_ROUTING_CHANGE=NO/);
  assert.match(result.stdout, /LIVE_GITHUB_RECONCILIATION=DISABLED/);
  assert.match(result.stdout, /NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES/);
});

test("public fixture domain gate defaults to a non-mutating plan", () => {
  const result = runPlan(domainGate);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(result.stdout, /HOSTNAME=control\.rozkalns\.net/);
  assert.match(result.stdout, /AUTHORIZED_APPLY=CUSTOM_DOMAIN_ATTACH_EXACT_ACTIVE_VERSION/);
  assert.match(result.stdout, /LIVE_GITHUB_RECONCILIATION=DISABLED/);
  assert.match(result.stdout, /NO_BLIND_RETRY_AFTER_DOMAIN_ATTACH_STARTED=YES/);
});

test("deploy gate binds authorization to exact main SHA and exact-main CI", async () => {
  const source = await readFile(deployGate, "utf8");
  assert.match(source, /CONTROL_OWNER_AUTHORIZATION/);
  assert.match(source, /authorize Phase 2 public fixture non-routable deploy /);
  assert.match(source, /assertExactRepositoryState\(args\.sha\)/);
  assert.match(source, /assertExactMainCi\(args\.sha, args\.ci\)/);
  assert.match(source, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(source, /DEPLOY_STARTED=YES/);
  assert.match(source, /POST_DEPLOY_STATE=RECONCILIATION_REQUIRED/);
});

test("deploy gate has exactly one reviewed Cloudflare write command and keeps routing absent", async () => {
  const source = await readFile(deployGate, "utf8");
  const deployCommands = source.match(/"deploy"/g) ?? [];
  assert.equal(deployCommands.length, 1);
  assert.match(source, /"--strict"/);
  assert.match(source, /"--experimental-provision=false"/);
  assert.match(source, /"--experimental-auto-create=false"/);
  assert.match(source, /"--install-skills=false"/);
  assert.doesNotMatch(source, /workers\/domains[^\n]*method:\s*"PUT"/);
  assert.doesNotMatch(source, /versions",\s*"deploy"/);
  assert.doesNotMatch(source, /secret",\s*"put"/);
});

test("domain gate binds authorization to exact active version and has one PUT mutation", async () => {
  const source = await readFile(domainGate, "utf8");
  assert.match(source, /--expected-version-id/);
  assert.match(source, /authorize Phase 2 public fixture domain attach/);
  assert.match(source, /assertExactActiveFixtureVersion\(token, args\.version, \{ domainMustBeAbsent: true \}\)/);
  assert.match(source, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(source, /DOMAIN_ATTACH_STARTED=YES/);
  assert.match(source, /POST_DOMAIN_ATTACH_STATE=RECONCILIATION_REQUIRED/);
  assert.equal((source.match(/method:\s*"PUT"/g) ?? []).length, 1);
  assert.match(source, /hostname:\s*PUBLIC_HOSTNAME/);
  assert.match(source, /service:\s*WORKER_NAME/);
  assert.match(source, /zone_name:\s*ZONE_NAME/);
  assert.doesNotMatch(source, /method:\s*"DELETE"/);
  assert.doesNotMatch(source, /method:\s*"POST"/);
});

test("shared verifier pins the reviewed live baseline and deployed bindings", async () => {
  const source = await readFile(common, "utf8");
  assert.match(source, /38819190-ab13-4865-8976-7b5f7d1c1966/);
  assert.match(source, /44fb14ab-b3d4-42eb-aebb-a2612332eef6/);
  assert.match(source, /ca152e0e-295c-47a0-8637-2cd146242e74/);
  assert.match(source, /GITHUB_APP_PRIVATE_KEY_PEM/);
  assert.match(source, /CONTROL_DB/);
  assert.match(source, /8504e986-faf0-450c-bfb5-41b5dbf8be09/);
  assert.match(source, /CONTROL_GITHUB_LIVE_READS/);
  assert.match(source, /LIVE_READS_DISABLED = "disabled"/);
  assert.match(source, /workers_dev must be explicitly false/);
  assert.match(source, /Preview URLs must remain disabled/);
  assert.match(source, /TARGET_DOMAIN_ALREADY_PRESENT/);
  assert.match(source, /WORKER_DOMAIN_ALREADY_PRESENT/);
});

test("webhook remains fail-closed during the public fixture milestone", async () => {
  const source = await readFile("src/worker/index.ts", "utf8");
  assert.match(source, /secret:\s*null/);
  assert.match(source, /acceptor:\s*null/);
});

test("apply modes fail before network access without privileged inputs", () => {
  const sha = "0".repeat(40);
  const deploy = spawnSync(
    process.execPath,
    [deployGate, "--mode", "apply", "--expected-sha", sha, "--expected-ci-run-id", "1"],
    { cwd: process.cwd(), encoding: "utf8", env: {} },
  );
  assert.notEqual(deploy.status, 0);
  assert.match(deploy.stderr, /CLOUDFLARE_TOKEN_REQUIRED/);

  const domain = spawnSync(
    process.execPath,
    [
      domainGate,
      "--mode",
      "apply",
      "--expected-sha",
      sha,
      "--expected-ci-run-id",
      "1",
      "--expected-version-id",
      "38819190-ab13-4865-8976-7b5f7d1c1966",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: {} },
  );
  assert.notEqual(domain.status, 0);
  assert.match(domain.stderr, /CLOUDFLARE_TOKEN_REQUIRED/);
});
