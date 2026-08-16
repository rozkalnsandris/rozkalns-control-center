import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gate = "scripts/cloudflare-needs-changes-d1-migration-gate.mjs";
const retiredWorkflow = ".github/workflows/production-d1.yml";

test("Needs changes D1 gate defaults to a credential-free non-mutating plan", () => {
  const result = spawnSync(process.execPath, [gate], { encoding: "utf8", env: {} });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /LOCAL_APPLY_HOST=lenovo/);
  assert.match(result.stdout, /GITHUB_ACTIONS_APPLY=FORBIDDEN/);
  assert.match(result.stdout, /BASE_MIGRATION=0001_reconciliation_core\.sql/);
  assert.match(result.stdout, /TARGET_MIGRATION=0002_needs_changes_audit\.sql/);
  assert.match(result.stdout, /PREWRITE_D1_VERIFICATION=GET_AND_SELECT_ONLY/);
  assert.match(result.stdout, /PREWRITE_EXPECTED_HISTORY=0001_ONLY/);
  assert.match(result.stdout, /PREWRITE_EXPECTED_TARGET_SCHEMA=ABSENT/);
  assert.match(result.stdout, /REMOTE_D1_MUTATION=NO/);
  assert.match(result.stdout, /NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES/);
});

test("gate pins the exact production D1, toolchain and reviewed migrations", async () => {
  const source = await readFile(gate, "utf8");
  for (const expected of [
    "70e29dbca0e8363358659102d2b74178",
    "rozkalns-control-production",
    "8504e986-faf0-450c-bfb5-41b5dbf8be09",
    'const JURISDICTION = "eu"',
    "0001_reconciliation_core.sql",
    "95d388b6405cce25f5b36caa78ec08b8d74cb17186a3e788802cc5251742efc3",
    "0002_needs_changes_audit.sql",
    "8e0f3500c56bf395a11c6041aed6bbceebb16928fd6786860428d329142b2a65",
    "4.120.0",
    "22.12.0",
  ]) assert.ok(source.includes(expected), `missing ${expected}`);
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /MIGRATION_SET_INVALID/);
  assert.match(source, /BASE_MIGRATION_HASH_INVALID/);
  assert.match(source, /TARGET_MIGRATION_HASH_INVALID/);
  assert.match(source, /TARGET_MIGRATION_SCOPE_INVALID/);
  assert.match(source, /TARGET_MIGRATION_TOUCHES_EXISTING_TABLE/);
  assert.match(source, /TARGET_MIGRATION_STATEMENTS_INVALID/);
});

test("apply is local-owner only and exact-main plus exact-CI bound", async () => {
  const source = await readFile(gate, "utf8");
  for (const guard of [
    "ACTIONS_EXECUTION_FORBIDDEN",
    "WRONG_HOST",
    "BRANCH_NOT_MAIN",
    "WORKTREE_DIRTY",
    "HEAD_MISMATCH",
    "REMOTE_MAIN_MISMATCH",
    "CI_GATE_INVALID",
    "OWNER_AUTHORIZATION_INVALID",
    "D1_RESOURCE_IDENTITY_INVALID",
  ]) assert.ok(source.includes(guard));
  assert.match(source, /hostname\(\)\.split/);
  assert.match(source, /git", \["fetch", "--quiet", "origin", "main"\]/);
  assert.match(source, /payload\?\.head_branch !== "main"/);
  assert.match(source, /payload\?\.event !== "push"/);
  assert.match(source, /payload\?\.status !== "completed"/);
  assert.match(source, /payload\?\.conclusion !== "success"/);
});

test("prewrite and postwrite evidence are SELECT-only and exact-schema bound", async () => {
  const source = await readFile(gate, "utf8");
  for (const expected of [
    "PREWRITE_REMOTE_STATE_INVALID",
    "PREWRITE_MIGRATION_HISTORY=0001_ONLY",
    "PREWRITE_APPLICATION_SCHEMA=PHASE2_EXACT",
    "PREWRITE_TARGET_SCHEMA=ABSENT",
    "POSTWRITE_REMOTE_STATE_INVALID",
    "POSTWRITE_MIGRATION_HISTORY=0001_0002",
    "POSTWRITE_APPLICATION_SCHEMA=PHASE3_EXACT",
    "POSTWRITE_TARGET_ROWS=0",
    "D1_QUERY_NOT_READ_ONLY",
    "D1_QUERY_MUTATED",
  ]) assert.ok(source.includes(expected));
  assert.match(source, /SELECT id, name, applied_at FROM d1_migrations ORDER BY id/);
  assert.match(source, /SELECT type, name, tbl_name FROM sqlite_schema ORDER BY type, name/);
  assert.match(source, /SELECT COUNT\(\*\) AS row_count FROM webhook_deliveries/);
  assert.match(source, /SELECT COUNT\(\*\) AS row_count FROM needs_changes_decisions/);
  assert.doesNotMatch(source, /d1", "execute"/);
});

test("authorization is consumed before the only remote migration apply and failures never retry", async () => {
  const source = await readFile(gate, "utf8");
  const started = source.indexOf('console.log("APPLY_STARTED=YES")');
  const consumed = source.indexOf('console.log("AUTHORIZATION_CONSUMED=YES")');
  const external = source.indexOf("const result = spawnSync(\n    wrangler()", consumed);
  assert.ok(started >= 0 && consumed > started && external > consumed);

  const operations = source.match(/"d1",\s*\n\s*"migrations",\s*\n\s*"apply"/g) ?? [];
  assert.equal(operations.length, 1);
  assert.doesNotMatch(source, /"migrations",\s*"list"/);
  assert.match(source, /stdio: \["ignore", "inherit", "inherit"\]/);
  assert.match(source, /safeReconcileAfterCommandFailure/);
  assert.match(source, /RECONCILED_REMOTE_STATE/);
  assert.match(source, /POST_APPLY_STATE=REVIEW_REQUIRED/);
  assert.match(source, /AUTHORIZATION_STATUS=CONSUMED_RECONCILIATION_REQUIRED/);
  assert.match(source, /REMOTE_D1_MIGRATION_GATE=PASS/);
});

test("package exposes the dedicated gate and the old production D1 workflow remains inert", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  assert.equal(
    pkg.scripts?.["cf:needs-changes-d1-migration-gate"],
    "node scripts/cloudflare-needs-changes-d1-migration-gate.mjs",
  );

  const workflow = await readFile(retiredWorkflow, "utf8");
  assert.match(workflow, /name: Retired Production D1 Canary/);
  assert.match(workflow, /if: \$\{\{ false \}\}/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_D1_TOKEN|secrets\./);
  assert.doesNotMatch(workflow, /CONTROL_OWNER_AUTHORIZATION|0002_needs_changes_audit/);
});
