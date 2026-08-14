import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const gate = "scripts/cloudflare-d1-migration-gate.mjs";
const productionWorkflow = ".github/workflows/production-d1.yml";

type SchemaClassification = {
  valid: boolean;
  unexpected: Array<{ type: string; name: string; tbl_name: string }>;
};

type MigrationBootstrapClassification = {
  valid: boolean;
  present: boolean;
};

async function loadSchemaPolicy() {
  const moduleUrl = pathToFileURL(resolve("scripts/d1-schema-policy.mjs")).href;
  return (await import(moduleUrl)) as {
    classifyInitialD1SchemaRows(rows: unknown): SchemaClassification;
    classifyD1MigrationBootstrapSchemaRows(rows: unknown): MigrationBootstrapClassification;
  };
}

test("remote D1 gate defaults to a credential-free non-mutating plan", () => {
  const result = spawnSync(process.execPath, [gate], { encoding: "utf8", env: {} });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MODE=PLAN/);
  assert.match(result.stdout, /NODE_MINIMUM=22\.12\.0/);
  assert.match(result.stdout, /GITHUB_ACTIONS_CONTEXT=github-hosted Linux issue_comment default-branch workflow/);
  assert.match(result.stdout, /PREWRITE_D1_VERIFICATION=GET_AND_SELECT_ONLY/);
  assert.match(result.stdout, /PREWRITE_MIGRATION_BOOTSTRAP=ABSENT_OR_CANONICAL_EMPTY/);
  assert.match(result.stdout, /PREWRITE_WRANGLER_MIGRATIONS_LIST=DISABLED/);
  assert.match(result.stdout, /REMOTE_D1_MUTATION=NO/);
  assert.match(result.stdout, /NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES/);
});

test("gate pins reviewed resource, workflow and source identities", async () => {
  const source = await readFile(gate, "utf8");
  for (const expected of [
    "lenovo",
    "production-d1.yml",
    "github-hosted",
    "70e29dbca0e8363358659102d2b74178",
    "rozkalns-control-production",
    "8504e986-faf0-450c-bfb5-41b5dbf8be09",
    "0001_reconciliation_core.sql",
    "95d388b6405cce25f5b36caa78ec08b8d74cb17186a3e788802cc5251742efc3",
    "4.120.0",
    "22.12.0",
  ]) assert.ok(source.includes(expected));
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /REMOTE_MAIN_MISMATCH/);
  assert.match(source, /CI_GATE_INVALID/);
  assert.match(source, /OWNER_AUTHORIZATION_INVALID/);
  assert.match(source, /EXECUTION_CONTEXT_INVALID/);
  assert.match(source, /GITHUB_REPOSITORY/);
  assert.match(source, /GITHUB_EVENT_NAME/);
  assert.match(source, /GITHUB_REF/);
  assert.match(source, /GITHUB_SHA/);
  assert.match(source, /GITHUB_WORKFLOW_REF/);
  assert.match(source, /RUNNER_ENVIRONMENT/);
  assert.match(source, /RUNNER_OS/);
});

test("central production D1 workflow is owner-only, default-branch bound and least privilege", async () => {
  const workflow = await readFile(productionWorkflow, "utf8");
  assert.match(workflow, /issue_comment:\s*\n\s+types: \[created\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /github\.event\.issue\.number == 74/);
  assert.match(workflow, /!github\.event\.issue\.pull_request/);
  assert.match(workflow, /github\.event\.comment\.user\.id == 277435981/);
  assert.match(workflow, /startsWith\(github\.event\.comment\.body, 'authorize Phase 2 remote D1 migration rozkalns-control-production '\)/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(workflow, /self-hosted/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /AUTHORIZATION: \$\{\{ github\.event\.comment\.body \}\}/);
  assert.match(workflow, /EVENT_MAIN_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /STOP=AUTHORIZATION_SHA_STALE/);
  assert.match(workflow, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_TOKEN \}\}/);
  assert.match(workflow, /CONTROL_OWNER_AUTHORIZATION: \$\{\{ github\.event\.comment\.body \}\}/);
  assert.match(workflow, /--mode apply/);
  assert.match(workflow, /--expected-sha "\$EXPECTED_SHA"/);
  assert.match(workflow, /--expected-ci-run-id "\$EXPECTED_CI"/);
});

test("D1 system namespaces are tolerated during first-bootstrap schema inspection", async () => {
  const { classifyInitialD1SchemaRows } = await loadSchemaPolicy();
  const result = classifyInitialD1SchemaRows([
    { type: "table", name: "sqlite_sequence", tbl_name: "sqlite_sequence" },
    { type: "table", name: "_cf_KV", tbl_name: "_cf_KV" },
    { type: "index", name: "sqlite_autoindex__cf_KV_1", tbl_name: "_cf_KV" },
    { type: "index", name: "provider_internal_index", tbl_name: "_cf_KV" },
    { type: "table", name: "d1_internal", tbl_name: "d1_internal" },
  ]);
  assert.deepEqual(result, { valid: true, unexpected: [] });
});

test("unexpected application schema objects fail the first-bootstrap policy", async () => {
  const { classifyInitialD1SchemaRows } = await loadSchemaPolicy();
  const result = classifyInitialD1SchemaRows([
    { type: "table", name: "users", tbl_name: "users" },
    { type: "view", name: "reporting_view", tbl_name: "reporting_view" },
    { type: "index", name: "idx_users_email", tbl_name: "users" },
    { type: "trigger", name: "users_audit", tbl_name: "users" },
    { type: "index", name: "_cf_lookalike", tbl_name: "users" },
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.unexpected.map((row) => row.name),
    ["users", "reporting_view", "idx_users_email", "users_audit", "_cf_lookalike"],
  );
});

test("malformed schema evidence fails closed", async () => {
  const { classifyInitialD1SchemaRows } = await loadSchemaPolicy();
  for (const value of [null, {}, [{ type: "table", name: "_cf_KV" }], [{ type: "virtual", name: "_cf_KV", tbl_name: "_cf_KV" }]]) {
    assert.equal(classifyInitialD1SchemaRows(value).valid, false);
  }
});

test("migration bootstrap accepts absent or canonical empty Wrangler history schema", async () => {
  const { classifyD1MigrationBootstrapSchemaRows } = await loadSchemaPolicy();
  assert.deepEqual(classifyD1MigrationBootstrapSchemaRows([]), { valid: true, present: false });
  assert.deepEqual(
    classifyD1MigrationBootstrapSchemaRows([
      {
        type: "index",
        name: "sqlite_autoindex_d1_migrations_1",
        tbl_name: "d1_migrations",
        sql: null,
      },
      {
        type: "table",
        name: "d1_migrations",
        tbl_name: "d1_migrations",
        sql: `CREATE TABLE "d1_migrations"(
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT UNIQUE,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )`,
      },
    ]),
    { valid: true, present: true },
  );
});

test("migration bootstrap schema is fail closed for noncanonical or extra history-owned objects", async () => {
  const { classifyD1MigrationBootstrapSchemaRows } = await loadSchemaPolicy();
  for (const rows of [
    null,
    [{ type: "table", name: "d1_migrations", tbl_name: "d1_migrations", sql: "CREATE TABLE d1_migrations(name TEXT)" }],
    [
      { type: "index", name: "sqlite_autoindex_d1_migrations_1", tbl_name: "d1_migrations", sql: null },
      { type: "table", name: "d1_migrations", tbl_name: "d1_migrations", sql: "CREATE TABLE d1_migrations(name TEXT)" },
    ],
    [
      { type: "index", name: "sqlite_autoindex_d1_migrations_1", tbl_name: "d1_migrations", sql: null },
      {
        type: "table",
        name: "d1_migrations",
        tbl_name: "d1_migrations",
        sql: 'CREATE TABLE "d1_migrations"( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL )',
      },
      { type: "trigger", name: "unexpected_history_trigger", tbl_name: "d1_migrations", sql: "CREATE TRIGGER unexpected_history_trigger" },
    ],
  ]) {
    assert.equal(classifyD1MigrationBootstrapSchemaRows(rows).valid, false);
  }
});

test("prewrite and postverify guards are fail closed without num_tables", async () => {
  const source = await readFile(gate, "utf8");
  for (const guard of [
    "PREWRITE_APPLICATION_SCHEMA_PRESENT",
    "PREWRITE_MIGRATION_HISTORY_SCHEMA_INVALID",
    "PREWRITE_MIGRATION_HISTORY_NOT_EMPTY",
    "PREWRITE_SCHEMA_EVIDENCE_INVALID",
    "PREWRITE_UNEXPECTED_USER_SCHEMA",
    "D1_QUERY_NOT_READ_ONLY",
    "D1_QUERY_MUTATED",
    "POST_VERIFY_MIGRATION_HISTORY",
    "POST_VERIFY_SCHEMA_INVALID",
    "POST_VERIFY_DELIVERY_ROWS",
  ]) assert.ok(source.includes(guard));
  assert.doesNotMatch(source, /PREWRITE_PROJECT_SCHEMA_PRESENT/);
  assert.doesNotMatch(source, /PREWRITE_DATABASE_NOT_EMPTY/);
  assert.doesNotMatch(source, /num_tables/);
  assert.match(source, /SELECT id, name, applied_at FROM d1_migrations ORDER BY id/);
  assert.match(source, /history\.length !== 0/);
});

test("prewrite never invokes Wrangler migrations list and apply remains the sole migration command", async () => {
  const source = await readFile(gate, "utf8");
  assert.doesNotMatch(source, /"migrations",\s*"list"/);
  const operations = source.match(/\["d1", "migrations", "(?:list|apply)"/g) ?? [];
  assert.deepEqual(operations, ['["d1", "migrations", "apply"']);
  assert.match(source, /PENDING_MIGRATIONS=0_PROVEN_BY_SOURCE_HISTORY_MATCH/);
});

test("authorization is consumed before the guarded apply and failures require review", async () => {
  const source = await readFile(gate, "utf8");
  const started = source.indexOf('console.log("APPLY_STARTED=YES")');
  const consumed = source.indexOf('console.log("AUTHORIZATION_CONSUMED=YES")');
  const externalProcess = source.indexOf("const r = spawnSync(wrangler()");
  assert.ok(started >= 0 && consumed > started && externalProcess > consumed);
  assert.match(source, /stdio: \["ignore", "inherit", "inherit"\]/);
  assert.match(source, /POST_APPLY_STATE=REVIEW_REQUIRED/);
  assert.match(source, /REMOTE_D1_MIGRATION_GATE=PASS/);
});

test("package and CI expose a compatible Node contract", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  const production = await readFile(productionWorkflow, "utf8");
  assert.equal(pkg.engines?.node, ">=22.12.0");
  assert.match(pkg.scripts?.test ?? "", /node --experimental-sqlite --test/);
  assert.equal(pkg.scripts?.["cf:d1-migration-gate"], "node scripts/cloudflare-d1-migration-gate.mjs");
  assert.match(ci, /node-version:\s*22\.16\.0/);
  assert.match(production, /node-version:\s*22\.16\.0/);
});
