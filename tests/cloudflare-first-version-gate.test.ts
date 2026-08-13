import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = "scripts/cloudflare-first-version-gate.mjs";
const wranglerConfigPath = "wrangler.jsonc";

function runPlan() {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
}

test("first-bootstrap controller defaults to a non-mutating plan", () => {
  const result = runPlan();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /WORKER=rozkalns-control/);
  assert.match(result.stdout, /CLOUDFLARE_MUTATION=NO/);
  assert.match(result.stdout, /AUTHORIZED_APPLY_CREATES_INITIAL_DEPLOYMENT=YES/);
  assert.match(result.stdout, /PUBLIC_ROUTING=NO/);
  assert.match(result.stdout, /WORKERS_DEV=DISABLED/);
  assert.match(result.stdout, /PREVIEW_URLS=DISABLED/);
  assert.match(result.stdout, /OWNER_AUTHORIZATION_FORMAT=authorize Phase 2 Cloudflare first non-routable bootstrap <exact-main-sha>/);
  assert.equal(result.stderr, "");
});

test("apply path is one-shot, exact-main bound and token-separated", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /CONTROL_OWNER_AUTHORIZATION/);
  assert.match(source, /authorize Phase 2 Cloudflare first non-routable bootstrap /);
  assert.doesNotMatch(source, /authorize Phase 2 Cloudflare first non-deployed version /);
  assert.match(source, /git", \["branch", "--show-current"\]/);
  assert.match(source, /git", \["status", "--porcelain"\]/);
  assert.match(source, /git", \["fetch", "--quiet", "origin", "main"\]/);
  assert.match(source, /REMOTE_MAIN_MISMATCH/);
  assert.match(source, /TOKEN_SEPARATION_REQUIRED/);
  assert.match(source, /TARGET_ALREADY_EXISTS/);
});

test("controller performs exactly the documented initial deploy and no follow-up traffic mutation", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /\[\s*"deploy",/);
  assert.match(source, /"--strict"/);
  assert.match(source, /"--experimental-provision=false"/);
  assert.match(source, /"--experimental-auto-create=false"/);
  assert.match(source, /"--install-skills=false"/);
  assert.match(source, /"--secrets-file"/);
  assert.doesNotMatch(source, /"versions",\s*\n\s*"upload"/);
  assert.doesNotMatch(source, /"secret",\s*"put"/);
  assert.doesNotMatch(source, /"versions",\s*"deploy"/);
  assert.doesNotMatch(source, /"triggers",\s*"deploy"/);
  assert.match(source, /POST_VERIFY_DEPLOYMENT_COUNT/);
  assert.match(source, /INITIAL_DEPLOYMENTS=1/);
});

test("Wrangler configuration makes the initial deployment non-routable", async () => {
  const config = JSON.parse(await readFile(wranglerConfigPath, "utf8")) as Record<string, unknown>;

  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal("route" in config, false);
  assert.equal("routes" in config, false);
  assert.equal("custom_domain" in config, false);
  assert.equal("custom_domains" in config, false);
});

test("post-verify proves workers.dev, preview URLs and private-key binding stay bounded", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /\/workers\/scripts\/\$\{WORKER_NAME\}\/subdomain/);
  assert.match(source, /POST_VERIFY_WORKERS_DEV_ENABLED/);
  assert.match(source, /POST_VERIFY_PREVIEW_URLS_ENABLED/);
  assert.match(source, /PRIVATE_KEY_BINDING=PROVEN/);
  assert.match(source, /PUBLIC_ROUTING=NO/);
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
