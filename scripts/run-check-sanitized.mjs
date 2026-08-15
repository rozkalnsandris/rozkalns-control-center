#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const SENSITIVE_ENV_KEYS = [
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
];

const env = { ...process.env };
for (const key of SENSITIVE_ENV_KEYS) delete env[key];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const steps = [
  ["run", "verify:policy"],
  ["run", "audit:runtime"],
  ["run", "typecheck"],
  ["run", "lint"],
  ["test"],
  ["run", "build"],
  ["run", "cf:dry-run"],
];

for (const args of steps) {
  const result = spawnSync(npm, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`CHECK_STEP_START_FAILED=${args.join(" ")}`);
    process.exitCode = 1;
    break;
  }
  if (result.status !== 0) {
    console.error(`CHECK_STEP_FAILED=${args.join(" ")}`);
    process.exitCode = result.status ?? 1;
    break;
  }
}