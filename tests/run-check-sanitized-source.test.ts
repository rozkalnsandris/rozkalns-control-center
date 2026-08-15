import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync("scripts/run-check-sanitized.mjs", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

test("npm check routes through the sanitized runner", () => {
  assert.equal(pkg.scripts.check, "node scripts/run-check-sanitized.mjs");
});

test("sanitized check strips production and webhook credentials before child processes", () => {
  for (const key of [
    "CONTROL_GITHUB_WEBHOOK_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_PRIVATE_KEY_PEM",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_READ_TOKEN",
    "CLOUDFLARE_WRITE_TOKEN",
    "CONTROL_ACCESS_TOKEN",
    "CONTROL_OWNER_AUTHORIZATION",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ]) {
    assert.match(runner, new RegExp(`"${key}"`));
  }
  assert.match(runner, /for \(const key of SENSITIVE_ENV_KEYS\) delete env\[key\]/);
  assert.match(runner, /spawnSync\(npm, args, \{[\s\S]*?env,[\s\S]*?stdio: "inherit"/);
});

test("sanitized check preserves the complete reviewed check sequence without recursion", () => {
  for (const step of [
    '["run", "verify:policy"]',
    '["run", "audit:runtime"]',
    '["run", "typecheck"]',
    '["run", "lint"]',
    '["test"]',
    '["run", "build"]',
    '["run", "cf:dry-run"]',
  ]) {
    assert.ok(runner.includes(step), `missing check step ${step}`);
  }
  assert.doesNotMatch(runner, /\["run", "check"\]/);
});