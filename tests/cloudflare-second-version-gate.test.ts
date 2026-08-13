import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptPath = "scripts/cloudflare-second-version-gate.mjs";
const wranglerConfigPath = "wrangler.jsonc";
const packagePath = "package.json";

function runPlan() {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
}

test("second-version controller defaults to a credential-free non-mutating plan", () => {
  const result = runPlan();
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /WORKER=rozkalns-control/);
  assert.match(result.stdout, /EXPECTED_BOOTSTRAP_VERSION=38819190-ab13-4865-8976-7b5f7d1c1966/);
  assert.match(result.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(result.stdout, /AUTHORIZED_APPLY_UPLOADS_SECOND_VERSION=YES/);
  assert.match(result.stdout, /TRAFFIC_DEPLOYMENT=NO/);
  assert.match(result.stdout, /PUBLIC_ROUTING_CHANGE=NO/);
  assert.match(result.stdout, /LOCAL_PRIVATE_KEY_REQUIRED=NO/);
  assert.match(
    result.stdout,
    /OWNER_AUTHORIZATION_FORMAT=authorize Phase 2 Cloudflare second non-deployed version upload <exact-main-sha>/,
  );
});

test("apply is exact-main bound, token-separated and owner-authorized", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /CONTROL_OWNER_AUTHORIZATION/);
  assert.match(source, /authorize Phase 2 Cloudflare second non-deployed version upload /);
  assert.match(source, /git", \["branch", "--show-current"\]/);
  assert.match(source, /git", \["status", "--porcelain"\]/);
  assert.match(source, /git", \["fetch", "--quiet", "origin", "main"\]/);
  assert.match(source, /REMOTE_MAIN_MISMATCH/);
  assert.match(source, /TOKEN_SEPARATION_REQUIRED/);
  assert.match(source, /TARGET_MISSING/);
});

test("prewrite gate requires the exact known bootstrap state before any upload", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /BOOTSTRAP_VERSION_ID = "38819190-ab13-4865-8976-7b5f7d1c1966"/);
  assert.match(source, /PREWRITE_VERSION_BASELINE/);
  assert.match(source, /assertSingleBootstrapDeployment\(beforeDeployments, "PREWRITE"\)/);
  assert.match(source, /PREWRITE_PRIVATE_KEY_BINDING/);
  assert.match(source, /assertSubdomainDisabled\(accountId, readToken, "PREWRITE"\)/);
});

test("the sole Cloudflare write is a strict non-deployed versions upload", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /"versions",\s*\n\s*"upload"/);
  assert.match(source, /"--strict"/);
  assert.match(source, /"--experimental-provision=false"/);
  assert.match(source, /"--experimental-auto-create=false"/);
  assert.match(source, /"--install-skills=false"/);
  assert.doesNotMatch(source, /"versions",\s*\n\s*"deploy"/);
  assert.doesNotMatch(source, /\[\s*"deploy",/);
  assert.doesNotMatch(source, /"triggers",\s*\n\s*"deploy"/);
  assert.doesNotMatch(source, /"--preview-alias"/);
  assert.doesNotMatch(source, /"secret",\s*\n\s*"(?:put|delete|bulk)"/);
  assert.doesNotMatch(source, /"versions",\s*\n\s*"secret"/);
  assert.doesNotMatch(source, /"--secrets-file"/);
});

test("postverify proves the new version exists while traffic deployment is unchanged", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /POST_VERIFY_VERSION_COUNT/);
  assert.match(source, /afterVersions\.length !== 2/);
  assert.match(source, /POST_VERIFY_NEW_VERSION_ID/);
  assert.match(source, /POST_VERIFY_DEPLOYMENT_CHANGED/);
  assert.match(source, /afterDeploymentId !== beforeDeploymentId/);
  assert.match(source, /PRIVATE_KEY_BINDING=PROVEN_ON_NEW_VERSION/);
  assert.match(source, /DEPLOYMENT_UNCHANGED=YES/);
  assert.match(source, /TRAFFIC_DEPLOYMENT=NO/);
  assert.match(source, /POST_UPLOAD_STATE=REVIEW_REQUIRED/);
});

test("source configuration remains non-routable for the guarded upload", async () => {
  const config = JSON.parse(await readFile(wranglerConfigPath, "utf8")) as Record<string, unknown>;

  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  for (const forbidden of ["route", "routes", "triggers", "custom_domain", "custom_domains"]) {
    assert.equal(forbidden in config, false);
  }
});

test("package exposes only the explicit second-version gate entrypoint", async () => {
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.scripts?.["cf:second-version-gate"], "node scripts/cloudflare-second-version-gate.mjs");
});

test("apply fails before network access when required authorization inputs are absent", () => {
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--mode", "apply", "--expected-sha", "0000000000000000000000000000000000000000"],
    { cwd: process.cwd(), encoding: "utf8", env: {} },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ACCOUNT_ID_INVALID/);
  assert.doesNotMatch(result.stderr, /Bearer|PRIVATE KEY|ghs_/);
});
