import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = "scripts/cloudflare-first-version-gate.mjs";

function runPlan() {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
}

test("first-version controller defaults to a non-mutating plan", () => {
  const result = runPlan();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /WORKER=rozkalns-control/);
  assert.match(result.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(result.stdout, /TRAFFIC_DEPLOYMENT=NO/);
  assert.match(result.stdout, /OWNER_AUTHORIZATION_FORMAT=authorize Phase 2 Cloudflare first non-deployed version <exact-main-sha>/);
  assert.equal(result.stderr, "");
});

test("apply path is one-shot, exact-main bound and token-separated", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /CONTROL_OWNER_AUTHORIZATION/);
  assert.match(source, /authorize Phase 2 Cloudflare first non-deployed version /);
  assert.match(source, /git", \["branch", "--show-current"\]/);
  assert.match(source, /git", \["status", "--porcelain"\]/);
  assert.match(source, /git", \["fetch", "--quiet", "origin", "main"\]/);
  assert.match(source, /REMOTE_MAIN_MISMATCH/);
  assert.match(source, /TOKEN_SEPARATION_REQUIRED/);
  assert.match(source, /TARGET_ALREADY_EXISTS/);
});

test("controller can only upload a version and cannot deploy traffic", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /"versions",\s*\n\s*"upload"/);
  assert.match(source, /"--strict"/);
  assert.match(source, /"--experimental-provision=false"/);
  assert.match(source, /"--experimental-auto-create=false"/);
  assert.match(source, /"--secrets-file"/);
  assert.doesNotMatch(source, /\[\s*"deploy"/);
  assert.doesNotMatch(source, /"secret",\s*"put"/);
  assert.doesNotMatch(source, /"versions",\s*"deploy"/);
  assert.doesNotMatch(source, /"triggers",\s*"deploy"/);
  assert.match(source, /POST_VERIFY_DEPLOYMENT_PRESENT/);
  assert.match(source, /ACTIVE_DEPLOYMENTS=0/);
});

test("secret material is confined to a mode-0600 temporary file and cleaned up", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /GITHUB_APP_PRIVATE_KEY_PEM/);
  assert.match(source, /metadata\.mode & 0o077/);
  assert.match(source, /mode: 0o600/);
  assert.match(source, /finally \{/);
  assert.match(source, /rm\(tempRoot, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:pem|readToken|writeToken)/i);
});

test("apply fails before network access when required authorization inputs are absent", () => {
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--mode", "apply", "--expected-sha", "0000000000000000000000000000000000000000"],
    { cwd: process.cwd(), encoding: "utf8", env: {} },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ACCOUNT_ID_INVALID/);
  assert.doesNotMatch(result.stderr, /BEGIN (?:RSA )?PRIVATE KEY/);
});
