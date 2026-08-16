#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { classifyD1MigrationBootstrapSchemaRows } from "./d1-schema-policy.mjs";

const REPO = "rozkalnsandris/rozkalns-control-center";
const HOST = "lenovo";
const ACCOUNT = "70e29dbca0e8363358659102d2b74178";
const DB_NAME = "rozkalns-control-production";
const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
const JURISDICTION = "eu";
const WRANGLER_VERSION = "4.120.0";
const NODE_MINIMUM = "22.12.0";
const BASE_MIGRATION = "0001_reconciliation_core.sql";
const BASE_MIGRATION_SHA256 = "95d388b6405cce25f5b36caa78ec08b8d74cb17186a3e788802cc5251742efc3";
const TARGET_MIGRATION = "0002_needs_changes_audit.sql";
const TARGET_MIGRATION_SHA256 = "8e0f3500c56bf395a11c6041aed6bbceebb16928fd6786860428d329142b2a65";
const AUTH_PREFIX = `authorize Phase 3 remote D1 migration ${DB_NAME} ${TARGET_MIGRATION} `;
const CF = "https://api.cloudflare.com/client/v4";
const GH = "https://api.github.com";

const PRE_APPLICATION_SCHEMA = Object.freeze([
  "index:idx_webhook_deliveries_repository_updated_at:webhook_deliveries",
  "index:idx_webhook_deliveries_state_updated_at:webhook_deliveries",
  "index:sqlite_autoindex_webhook_deliveries_1:webhook_deliveries",
  "table:webhook_deliveries:webhook_deliveries",
].sort());

const POST_APPLICATION_SCHEMA = Object.freeze([
  ...PRE_APPLICATION_SCHEMA,
  "index:idx_needs_changes_decisions_repository_pull_requested_at:needs_changes_decisions",
  "index:idx_needs_changes_decisions_state_requested_at:needs_changes_decisions",
  "index:sqlite_autoindex_needs_changes_decisions_1:needs_changes_decisions",
  "table:needs_changes_decisions:needs_changes_decisions",
].sort());

let mutationStarted = false;

function stop(code, message) {
  console.error(`STOP=${code}`);
  console.error(`${code}: ${message}`);
  console.error(`AUTHORIZATION_STATUS=${mutationStarted ? "CONSUMED_RECONCILIATION_REQUIRED" : "NOT_CONSUMED"}`);
  console.error("NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES");
  process.exitCode = 1;
  throw new Error(code);
}

function args(argv) {
  const out = { mode: "plan", sha: "", ci: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode") out.mode = argv[++i] ?? "";
    else if (argv[i] === "--expected-sha") out.sha = argv[++i] ?? "";
    else if (argv[i] === "--expected-ci-run-id") out.ci = argv[++i] ?? "";
    else stop("ARGUMENT_INVALID", `unsupported argument ${argv[i]}`);
  }
  if (!["plan", "apply"].includes(out.mode)) stop("MODE_INVALID", "mode must be plan or apply");
  return out;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CONTROL_OWNER_AUTHORIZATION",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ]) delete env[key];
  return { ...env, ...extra };
}

function run(cmd, argv, { inherit = false, env = cleanEnv() } = {}) {
  const result = spawnSync(cmd, argv, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env,
  });
  if (result.error || result.status !== 0) stop("COMMAND_FAILED", `${cmd} exited ${result.status ?? "unknown"}`);
  return inherit ? "" : `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function wrangler() {
  return resolve("node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

function assertInputs(input) {
  if (!/^[0-9a-f]{40}$/.test(input.sha)) stop("EXPECTED_SHA_INVALID", "expected SHA must be 40 lowercase hex characters");
  if (!/^[1-9][0-9]*$/.test(input.ci)) stop("CI_RUN_ID_INVALID", "CI run id must be a positive integer");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) stop("NODE_VERSION_INVALID", `Node ${NODE_MINIMUM}+ is required`);
  if (process.env.GITHUB_ACTIONS === "true") stop("ACTIONS_EXECUTION_FORBIDDEN", "Phase 3 D1 apply is intentionally local-owner only");
  if (hostname().split(".")[0].toLowerCase() !== HOST) stop("WRONG_HOST", `apply requires local host ${HOST}`);
}

function assertRepo(sha) {
  if (run("git", ["branch", "--show-current"]) !== "main") stop("BRANCH_NOT_MAIN", "apply requires main");
  if (run("git", ["status", "--porcelain"]) !== "") stop("WORKTREE_DIRTY", "apply requires a clean worktree");
  if (run("git", ["rev-parse", "HEAD"]) !== sha) stop("HEAD_MISMATCH", "local HEAD differs from authorized SHA");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== sha) stop("REMOTE_MAIN_MISMATCH", "origin/main moved from authorized SHA");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function stripSqlComments(sql) {
  return sql.replace(/^\s*--.*$/gm, "").trim();
}

async function assertSource() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.engines?.node !== ">=22.12.0" || pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) {
    stop("TOOL_PIN_INVALID", "Node/Wrangler source pins changed");
  }

  const cfg = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const d1 = Array.isArray(cfg?.d1_databases) ? cfg.d1_databases : [];
  if (
    d1.length !== 1 ||
    d1[0]?.binding !== "CONTROL_DB" ||
    d1[0]?.database_name !== DB_NAME ||
    d1[0]?.database_id !== DB_ID ||
    d1[0]?.migrations_dir !== "migrations"
  ) stop("D1_BINDING_INVALID", "production D1 binding changed");

  const files = (await readdir("migrations", { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(files) !== JSON.stringify([BASE_MIGRATION, TARGET_MIGRATION])) {
    stop("MIGRATION_SET_INVALID", "reviewed migration set changed");
  }

  if (await sha256(`migrations/${BASE_MIGRATION}`) !== BASE_MIGRATION_SHA256) {
    stop("BASE_MIGRATION_HASH_INVALID", "0001 migration hash changed");
  }
  if (await sha256(`migrations/${TARGET_MIGRATION}`) !== TARGET_MIGRATION_SHA256) {
    stop("TARGET_MIGRATION_HASH_INVALID", "0002 migration hash changed");
  }

  const targetSql = stripSqlComments(await readFile(`migrations/${TARGET_MIGRATION}`, "utf8"));
  if (/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i.test(targetSql)) {
    stop("TARGET_MIGRATION_SCOPE_INVALID", "0002 contains a forbidden mutating statement outside CREATE schema operations");
  }
  if (/webhook_deliveries/i.test(targetSql)) {
    stop("TARGET_MIGRATION_TOUCHES_EXISTING_TABLE", "0002 must not reference webhook_deliveries");
  }
  const statements = targetSql.split(";").map((value) => value.trim()).filter(Boolean);
  if (
    statements.length !== 3 ||
    !/^CREATE TABLE needs_changes_decisions\b/i.test(statements[0]) ||
    !/^CREATE INDEX idx_needs_changes_decisions_state_requested_at\b/i.test(statements[1]) ||
    !/^CREATE INDEX idx_needs_changes_decisions_repository_pull_requested_at\b/i.test(statements[2])
  ) stop("TARGET_MIGRATION_STATEMENTS_INVALID", "0002 is not the reviewed table-plus-two-index schema change");

  const version = run(wrangler(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "repository Wrangler version changed");
}

async function json(url, options, code) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    stop(code, "network request failed");
  }
  if (!response.ok) stop(code, `HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    stop(code, "response was not valid JSON");
  }
}

async function assertCi(sha, runId) {
  const payload = await json(
    `${GH}/repos/${REPO}/actions/runs/${runId}`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "rozkalns-control-needs-changes-d1-gate" } },
    "CI_READ_FAILED",
  );
  if (
    payload?.name !== "CI" ||
    payload?.path !== ".github/workflows/ci.yml" ||
    payload?.head_branch !== "main" ||
    payload?.head_sha !== sha ||
    payload?.event !== "push" ||
    payload?.status !== "completed" ||
    payload?.conclusion !== "success"
  ) stop("CI_GATE_INVALID", "run is not successful exact-main push CI");
}

async function cf(account, token, path, init = {}) {
  const payload = await json(
    `${CF}/accounts/${account}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    },
    "CLOUDFLARE_READ_FAILED",
  );
  if (payload?.success !== true) stop("CLOUDFLARE_READ_INVALID", "Cloudflare response was unsuccessful");
  return payload.result;
}

async function assertDb(account, token) {
  const db = await cf(account, token, `/d1/database/${DB_ID}`);
  if (db?.uuid !== DB_ID || db?.name !== DB_NAME || db?.jurisdiction !== JURISDICTION) {
    stop("D1_RESOURCE_IDENTITY_INVALID", "D1 identity does not match reviewed production target");
  }
}

async function select(account, token, sql) {
  if (!/^SELECT\b/i.test(sql.trim()) || /;\s*\S/.test(sql)) {
    stop("D1_QUERY_NOT_READ_ONLY", "verification query must be one SELECT");
  }
  const result = await cf(account, token, `/d1/database/${DB_ID}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0]?.results)) {
    stop("D1_QUERY_INVALID", "D1 query result was unexpected");
  }
  if (result[0]?.meta?.changed_db === true || Number(result[0]?.meta?.rows_written ?? 0) !== 0) {
    stop("D1_QUERY_MUTATED", "verification SELECT reported a write");
  }
  return result[0].results;
}

function applicationSchema(rows) {
  if (!Array.isArray(rows)) stop("SCHEMA_EVIDENCE_INVALID", "schema rows are not an array");
  const actual = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      stop("SCHEMA_EVIDENCE_INVALID", "schema row is malformed");
    }
    const type = row.type;
    const name = row.name;
    const tableName = row.tbl_name;
    if (typeof type !== "string" || typeof name !== "string" || typeof tableName !== "string") {
      stop("SCHEMA_EVIDENCE_INVALID", "schema row fields are malformed");
    }
    const normalized = tableName.toLowerCase();
    if (normalized.startsWith("sqlite_") || normalized.startsWith("d1_") || normalized.startsWith("_cf_")) continue;
    actual.push(`${type}:${name}:${tableName}`);
  }
  return actual.sort();
}

async function readRemoteState(account, token) {
  const migrationSchemaRows = await select(
    account,
    token,
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = 'd1_migrations' OR tbl_name = 'd1_migrations' ORDER BY type, name",
  );
  const migrationSchema = classifyD1MigrationBootstrapSchemaRows(migrationSchemaRows);
  if (!migrationSchema.valid || !migrationSchema.present) {
    stop("MIGRATION_HISTORY_SCHEMA_INVALID", "d1_migrations schema is not canonical");
  }

  const history = await select(account, token, "SELECT id, name, applied_at FROM d1_migrations ORDER BY id");
  const schemaRows = await select(account, token, "SELECT type, name, tbl_name FROM sqlite_schema ORDER BY type, name");
  const webhookCount = await select(account, token, "SELECT COUNT(*) AS row_count FROM webhook_deliveries");
  if (webhookCount.length !== 1 || !Number.isInteger(Number(webhookCount[0]?.row_count)) || Number(webhookCount[0]?.row_count) < 0) {
    stop("WEBHOOK_DELIVERY_COUNT_INVALID", "webhook_deliveries count evidence is invalid");
  }

  return {
    history,
    schema: applicationSchema(schemaRows),
    webhookRows: Number(webhookCount[0].row_count),
  };
}

function historyNames(history) {
  if (!Array.isArray(history)) return [];
  return history.map((row) => row?.name);
}

function isPrewriteState(state) {
  return (
    JSON.stringify(historyNames(state.history)) === JSON.stringify([BASE_MIGRATION]) &&
    JSON.stringify(state.schema) === JSON.stringify(PRE_APPLICATION_SCHEMA)
  );
}

async function assertPrewriteState(account, token) {
  const state = await readRemoteState(account, token);
  if (!isPrewriteState(state)) {
    stop("PREWRITE_REMOTE_STATE_INVALID", "production D1 is not the exact 0001-only baseline");
  }
  console.log(`PREWRITE_WEBHOOK_DELIVERY_ROWS=${state.webhookRows}`);
  console.log("PREWRITE_MIGRATION_HISTORY=0001_ONLY");
  console.log("PREWRITE_APPLICATION_SCHEMA=PHASE2_EXACT");
  console.log("PREWRITE_TARGET_SCHEMA=ABSENT");
}

async function assertPostwriteState(account, token) {
  const state = await readRemoteState(account, token);
  if (
    JSON.stringify(historyNames(state.history)) !== JSON.stringify([BASE_MIGRATION, TARGET_MIGRATION]) ||
    JSON.stringify(state.schema) !== JSON.stringify(POST_APPLICATION_SCHEMA)
  ) stop("POSTWRITE_REMOTE_STATE_INVALID", "production D1 is not the exact 0001+0002 schema state");

  const targetCount = await select(account, token, "SELECT COUNT(*) AS row_count FROM needs_changes_decisions");
  if (targetCount.length !== 1 || Number(targetCount[0]?.row_count) !== 0) {
    stop("POSTWRITE_TARGET_ROWS_INVALID", "new Needs changes audit table must be empty immediately after migration");
  }

  console.log(`POSTWRITE_WEBHOOK_DELIVERY_ROWS=${state.webhookRows}`);
  console.log("POSTWRITE_MIGRATION_HISTORY=0001_0002");
  console.log("POSTWRITE_APPLICATION_SCHEMA=PHASE3_EXACT");
  console.log("POSTWRITE_TARGET_ROWS=0");
}

async function safeReconcileAfterCommandFailure(account, token) {
  try {
    const state = await readRemoteState(account, token);
    const names = historyNames(state.history);
    if (isPrewriteState(state)) return "PREWRITE_UNCHANGED";
    if (
      JSON.stringify(names) === JSON.stringify([BASE_MIGRATION, TARGET_MIGRATION]) &&
      JSON.stringify(state.schema) === JSON.stringify(POST_APPLICATION_SCHEMA)
    ) return "TARGET_APPLIED";
    return "OTHER_REVIEW_REQUIRED";
  } catch {
    return "READ_FAILED_REVIEW_REQUIRED";
  }
}

function plan() {
  console.log("MODE=PLAN");
  console.log(`LOCAL_APPLY_HOST=${HOST}`);
  console.log("GITHUB_ACTIONS_APPLY=FORBIDDEN");
  console.log(`ACCOUNT_ID=${ACCOUNT}`);
  console.log(`DATABASE_NAME=${DB_NAME}`);
  console.log(`DATABASE_UUID=${DB_ID}`);
  console.log(`DATABASE_JURISDICTION=${JURISDICTION}`);
  console.log(`BASE_MIGRATION=${BASE_MIGRATION}`);
  console.log(`TARGET_MIGRATION=${TARGET_MIGRATION}`);
  console.log(`TARGET_MIGRATION_SHA256=${TARGET_MIGRATION_SHA256}`);
  console.log(`NODE_MINIMUM=${NODE_MINIMUM}`);
  console.log(`WRANGLER=${WRANGLER_VERSION}`);
  console.log("PREWRITE_D1_VERIFICATION=GET_AND_SELECT_ONLY");
  console.log("PREWRITE_EXPECTED_HISTORY=0001_ONLY");
  console.log("PREWRITE_EXPECTED_TARGET_SCHEMA=ABSENT");
  console.log("REMOTE_D1_MUTATION=NO");
  console.log(`OWNER_AUTHORIZATION_FORMAT=${AUTH_PREFIX}<exact-main-sha> ci <exact-ci-run-id>`);
  console.log("NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES");
  console.log("WORKER_DEPLOY_GITHUB_PERMISSION_QUEUE_WEBHOOK_MUTATION=NOT_AUTHORIZED");
}

async function apply(input) {
  assertInputs(input);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";
  if (account !== ACCOUNT) stop("ACCOUNT_ID_INVALID", "Cloudflare account does not match reviewed production account");
  if (!token) stop("CLOUDFLARE_API_TOKEN_REQUIRED", "production D1 token is required");
  if (authorization !== `${AUTH_PREFIX}${input.sha} ci ${input.ci}`) {
    stop("OWNER_AUTHORIZATION_INVALID", "one-shot authorization must match exact SHA and CI run");
  }

  assertRepo(input.sha);
  await assertSource();
  await assertCi(input.sha, input.ci);
  run("npm", ["run", "check"], { inherit: true });
  await assertDb(account, token);
  await assertPrewriteState(account, token);

  assertRepo(input.sha);
  await assertCi(input.sha, input.ci);
  await assertDb(account, token);
  await assertPrewriteState(account, token);

  console.log("APPLY_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES");
  mutationStarted = true;

  const result = spawnSync(
    wrangler(),
    [
      "d1",
      "migrations",
      "apply",
      DB_NAME,
      "--remote",
      "--config",
      "wrangler.jsonc",
      "--experimental-provision=false",
      "--experimental-auto-create=false",
      "--install-skills=false",
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "inherit", "inherit"],
      env: cleanEnv({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account }),
    },
  );

  if (result.error || result.status !== 0) {
    const reconciled = await safeReconcileAfterCommandFailure(account, token);
    console.error(`APPLY_COMMAND_RC=${result.status ?? "unknown"}`);
    console.error(`RECONCILED_REMOTE_STATE=${reconciled}`);
    console.error("POST_APPLY_STATE=REVIEW_REQUIRED");
    console.error("AUTHORIZATION_STATUS=CONSUMED_RECONCILIATION_REQUIRED");
    console.error("NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES");
    process.exitCode = 1;
    return;
  }

  console.log("APPLY_COMMAND_RC=0");
  await assertPostwriteState(account, token);
  console.log("REMOTE_D1_MIGRATION_GATE=PASS");
  console.log("AUTHORIZATION_STATUS=CONSUMED_SUCCESSFULLY");
  console.log("REMOTE_D1_MIGRATION=YES");
  console.log("WORKER_DEPLOY=NO");
  console.log("NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES");
}

const input = args(process.argv.slice(2));
try {
  if (input.mode === "plan") plan();
  else await apply(input);
} catch {
  if (!process.exitCode) process.exitCode = 1;
}
