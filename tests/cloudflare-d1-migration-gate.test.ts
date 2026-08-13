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
  assert.match(result.stdout, /NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES/);
});

test("gate pins reviewed resource and source identities", async () => {
  const source = await readFile(gate, "utf8");
  for (const expected of [
    "lenovo",
    "70e29dbca0e8363358659102d2b74178",
    "rozkalns-control-production",
    "8504e986-faf0-450c-bfb5-41b5dbf8be09",
    "0001_reconciliation_core.sql",
    "95d388b6405cce25f5b36caa78ec08b8d74cb17186a3e788802cc5251742efc3",
    "4.120.0",
  ]) assert.ok(source.includes(expected));
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /REMOTE_MAIN_MISMATCH/);
  assert.match(source, /CI_GATE_INVALID/);
  assert.match(source, /OWNER_AUTHORIZATION_INVALID/);
});

test("prewrite and postverify guards are fail closed", async () => {
  const source = await readFile(gate, "utf8");
  for (const guard of [
    "PREWRITE_DATABASE_NOT_EMPTY",
    "PREWRITE_PROJECT_SCHEMA_PRESENT",
    "PENDING_MIGRATION_SET_INVALID",
    "D1_QUERY_NOT_READ_ONLY",
    "D1_QUERY_MUTATED",
    "POST_VERIFY_MIGRATION_HISTORY",
    "POST_VERIFY_SCHEMA_INVALID",
    "POST_VERIFY_DELIVERY_ROWS",
    "POST_VERIFY_PENDING_MIGRATIONS",
  ]) assert.ok(source.includes(guard));
});

test("authorization is consumed before the guarded external process and failures require review", async () => {
  const source = await readFile(gate, "utf8");
  const consumed = source.indexOf('console.log("AUTHORIZATION_CONSUMED=YES")');
  const externalProcess = source.indexOf("const r = spawnSync(wrangler()");
  assert.ok(consumed >= 0 && externalProcess > consumed);
  assert.match(source, /stdio: \["ignore", "inherit", "inherit"\]/);
  assert.match(source, /POST_APPLY_STATE=REVIEW_REQUIRED/);
  assert.match(source, /REMOTE_D1_MIGRATION_GATE=PASS/);
});

test("package exposes the guarded controller", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["cf:d1-migration-gate"], "node scripts/cloudflare-d1-migration-gate.mjs");
});
