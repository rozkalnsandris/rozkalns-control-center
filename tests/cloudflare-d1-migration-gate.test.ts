import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gate = "scripts/cloudflare-d1-migration-gate.mjs";

test("remote D1 gate defaults to plan mode", () => {
  const result = spawnSync(process.execPath, [gate], { encoding: "utf8", env: {} });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /REMOTE_D1_MUTATION=NO/);
});

test("package exposes the guarded controller", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["cf:d1-migration-gate"], "node scripts/cloudflare-d1-migration-gate.mjs");
});
