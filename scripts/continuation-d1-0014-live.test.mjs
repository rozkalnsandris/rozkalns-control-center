import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DB_NAME,
  MIGRATION,
  MIGRATION_SHA256,
  PREDECESSOR_MIGRATIONS,
  SOURCE_MIGRATIONS,
  assertInputs,
  expectedAuthorization,
  inventoryStepPassed,
  normalizeSql,
  requireExactHistory,
  sha256,
} from "./continuation-d1-0014-live.mjs";

const SHA = "a".repeat(40);
const base = {
  sha: SHA,
  ciRun: "123",
  preflightRun: "456",
  migrationSha256: MIGRATION_SHA256,
  database: DB_NAME,
};

test("authorization binds exact source, CI, inventory run, migration digest and DB", () => {
  const authorization = expectedAuthorization(base);
  assert.equal(
    authorization,
    `AUTHORIZE LIVE CONTINUATION D1 0014 APPLY rozkalns-control-center source_sha=${SHA} ci_run=123 preflight_run=456 migration_sha256=${MIGRATION_SHA256} db=${DB_NAME} POST1 NO_RETRY NO_ROLLBACK NO_CLEANUP`,
  );
  assert.doesNotThrow(() => assertInputs({ ...base, authorization }));
});

test("authorization rejects altered evidence", () => {
  const authorization = expectedAuthorization(base);
  assert.throws(() => assertInputs({ ...base, ciRun: "124", authorization }), /OWNER_AUTHORIZATION_INVALID/);
  process.exitCode = undefined;
  assert.throws(() => assertInputs({ ...base, migrationSha256: "0".repeat(64), authorization }), /MIGRATION_SHA256_INVALID/);
  process.exitCode = undefined;
});

test("source migration set is exactly predecessor history plus 0014", () => {
  assert.equal(SOURCE_MIGRATIONS.length, 14);
  assert.deepEqual(SOURCE_MIGRATIONS.slice(0, -1), PREDECESSOR_MIGRATIONS);
  assert.equal(SOURCE_MIGRATIONS.at(-1), MIGRATION);
  assert.equal(PREDECESSOR_MIGRATIONS.at(-1), "0013_rpi5_observation_atomic_acceptance.sql");
});

test("reviewed 0014 digest and scope remain exact", async () => {
  const source = await readFile(`migrations/${MIGRATION}`);
  assert.equal(sha256(source), MIGRATION_SHA256);
  const text = source.toString("utf8");
  assert.match(text, /^-- Source only\./);
  assert.match(text, /CREATE TABLE continuation_action_audit/);
  assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
});

test("history validator requires exact ordered names and increasing integer IDs", () => {
  const exact = PREDECESSOR_MIGRATIONS.map((name, index) => ({ id: index + 1, name }));
  assert.doesNotThrow(() => requireExactHistory(exact, PREDECESSOR_MIGRATIONS));
  assert.throws(() => requireExactHistory([...exact, { id: 99, name: MIGRATION }], PREDECESSOR_MIGRATIONS), /MIGRATION_HISTORY_INVALID/);
  process.exitCode = undefined;
  const badIds = exact.map((row) => ({ ...row }));
  badIds[4].id = badIds[3].id;
  assert.throws(() => requireExactHistory(badIds, PREDECESSOR_MIGRATIONS), /MIGRATION_HISTORY_INVALID/);
  process.exitCode = undefined;
});

test("only a successful fixed-target inventory step proves the preflight class", () => {
  assert.equal(inventoryStepPassed([{ steps: [
    { name: "Fixed-target read-only inventory", status: "completed", conclusion: "success" },
    { name: "Token Analytics permission proof only", status: "completed", conclusion: "skipped" },
  ] }]), true);
  assert.equal(inventoryStepPassed([{ steps: [
    { name: "Fixed-target read-only inventory", status: "completed", conclusion: "skipped" },
  ] }]), false);
  assert.equal(inventoryStepPassed([{ steps: [
    { name: "Fixed-target read-only inventory", status: "completed", conclusion: "success" },
    { name: "Fixed-target read-only inventory", status: "completed", conclusion: "success" },
  ] }]), false);
});

test("SQL normalization is formatting-only", () => {
  assert.equal(normalizeSql("CREATE  TABLE X ( a TEXT );\n"), "create table x ( a text )");
});

test("workflow is first-attempt one-shot and exposes only D1 credentials", async () => {
  const workflow = await readFile(".github/workflows/continuation-d1-0014-live.yml", "utf8");
  assert.match(workflow, /environment: production-d1-live/);
  assert.match(workflow, /CLOUDFLARE_D1_READ_TOKEN/);
  assert.match(workflow, /CLOUDFLARE_D1_WRITE_TOKEN/);
  assert.match(workflow, /node scripts\/continuation-d1-0014-live\.mjs/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_ACCESS_WRITE_TOKEN|CONTROL_CONTINUATION_RUNTIME_ENABLED|production-worker-composite-live/);
});
