#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { classifyD1MigrationBootstrapSchemaRows, classifyInitialD1SchemaRows } from "./d1-schema-policy.mjs";

const REPO = "rozkalnsandris/rozkalns-control-center";
const HOST = "lenovo";
const ACCOUNT = "70e29dbca0e8363358659102d2b74178";
const DB_NAME = "rozkalns-control-production";
const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
const JURISDICTION = "eu";
const MIGRATION = "0001_reconciliation_core.sql";
const MIGRATION_SHA256 = "95d388b6405cce25f5b36caa78ec08b8d74cb17186a3e788802cc5251742efc3";
const WRANGLER_VERSION = "4.120.0";
const NODE_MINIMUM = "22.12.0";
const AUTH_PREFIX = `authorize Phase 2 remote D1 migration ${DB_NAME} `;
const CF = "https://api.cloudflare.com/client/v4";
const GH = "https://api.github.com";
const APPLICATION_SCHEMA = [
  "webhook_deliveries",
  "idx_webhook_deliveries_repository_updated_at",
  "idx_webhook_deliveries_state_updated_at",
];
const PROJECT_SCHEMA = ["d1_migrations", ...APPLICATION_SCHEMA];

function stop(code, message) {
  console.error(`STOP=${code}`);
  console.error(`${code}: ${message}`);
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
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CONTROL_OWNER_AUTHORIZATION", "GITHUB_TOKEN", "GH_TOKEN"]) delete env[key];
  return { ...env, ...extra };
}

function run(cmd, argv, { inherit = false, env = cleanEnv() } = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env,
  });
  if (r.error || r.status !== 0) stop("COMMAND_FAILED", `${cmd} exited ${r.status ?? "unknown"}`);
  return inherit ? "" : `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
}

function wrangler() {
  return resolve("node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

function assertInputs(a) {
  if (!/^[0-9a-f]{40}$/.test(a.sha)) stop("EXPECTED_SHA_INVALID", "expected SHA must be 40 lowercase hex characters");
  if (!/^[1-9][0-9]*$/.test(a.ci)) stop("CI_RUN_ID_INVALID", "CI run id must be a positive integer");
  const node = process.versions.node.split(".").map(Number);
  if (node[0] < 22 || (node[0] === 22 && node[1] < 12)) stop("NODE_VERSION_INVALID", `Node ${NODE_MINIMUM}+ is required`);
  if (hostname().split(".")[0].toLowerCase() !== HOST) stop("WRONG_HOST", `apply requires ${HOST}`);
}

function assertRepo(sha) {
  if (run("git", ["branch", "--show-current"]) !== "main") stop("BRANCH_NOT_MAIN", "apply requires main");
  if (run("git", ["status", "--porcelain"]) !== "") stop("WORKTREE_DIRTY", "apply requires a clean worktree");
  if (run("git", ["rev-parse", "HEAD"]) !== sha) stop("HEAD_MISMATCH", "local HEAD differs from authorized SHA");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== sha) stop("REMOTE_MAIN_MISMATCH", "origin/main moved from authorized SHA");
}

async function assertSource() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.engines?.node !== ">=22.12.0" || pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) stop("TOOL_PIN_INVALID", "Node/Wrangler source pins changed");
  const cfg = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const d1 = Array.isArray(cfg?.d1_databases) ? cfg.d1_databases : [];
  if (d1.length !== 1 || d1[0]?.binding !== "CONTROL_DB" || d1[0]?.database_name !== DB_NAME || d1[0]?.database_id !== DB_ID || d1[0]?.migrations_dir !== "migrations") stop("D1_BINDING_INVALID", "production D1 binding changed");
  const files = (await readdir("migrations", { withFileTypes: true })).filter((x) => x.isFile() && x.name.endsWith(".sql")).map((x) => x.name).sort();
  if (files.length !== 1 || files[0] !== MIGRATION) stop("MIGRATION_SET_INVALID", "reviewed migration set changed");
  const hash = createHash("sha256").update(await readFile(`migrations/${MIGRATION}`)).digest("hex");
  if (hash !== MIGRATION_SHA256) stop("MIGRATION_HASH_INVALID", "reviewed migration hash changed");
  const version = run(wrangler(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "repository Wrangler version changed");
}

async function json(url, options, code) {
  let r;
  try { r = await fetch(url, options); } catch { stop(code, "network request failed"); }
  if (!r.ok) stop(code, `HTTP ${r.status}`);
  try { return await r.json(); } catch { stop(code, "response was not valid JSON"); }
}

async function assertCi(sha, runId) {
  const p = await json(`${GH}/repos/${REPO}/actions/runs/${runId}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "rozkalns-control-d1-gate" } }, "CI_READ_FAILED");
  if (p?.name !== "CI" || p?.path !== ".github/workflows/ci.yml" || p?.head_branch !== "main" || p?.head_sha !== sha || p?.event !== "push" || p?.status !== "completed" || p?.conclusion !== "success") stop("CI_GATE_INVALID", "run is not successful exact-main push CI");
}

async function cf(account, token, path, init = {}) {
  const p = await json(`${CF}/accounts/${account}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.headers ?? {}) } }, "CLOUDFLARE_READ_FAILED");
  if (p?.success !== true) stop("CLOUDFLARE_READ_INVALID", "Cloudflare response was unsuccessful");
  return p.result;
}

async function assertDb(account, token) {
  const db = await cf(account, token, `/d1/database/${DB_ID}`);
  if (db?.uuid !== DB_ID || db?.name !== DB_NAME || db?.jurisdiction !== JURISDICTION) stop("D1_RESOURCE_IDENTITY_INVALID", "D1 identity does not match reviewed production target");
}

async function select(account, token, sql) {
  if (!/^SELECT\b/i.test(sql.trim()) || /;\s*\S/.test(sql)) stop("D1_QUERY_NOT_READ_ONLY", "verification query must be one SELECT");
  const result = await cf(account, token, `/d1/database/${DB_ID}/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
  if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0]?.results)) stop("D1_QUERY_INVALID", "D1 query result was unexpected");
  if (result[0]?.meta?.changed_db === true || Number(result[0]?.meta?.rows_written ?? 0) !== 0) stop("D1_QUERY_MUTATED", "verification SELECT reported a write");
  return result[0].results;
}

function schemaSql(names) {
  return names.map((x) => `'${x}'`).join(", ");
}

async function assertApplicationSchemaAbsent(account, token) {
  const rows = await select(account, token, `SELECT type, name, tbl_name FROM sqlite_schema WHERE name IN (${schemaSql(APPLICATION_SCHEMA)}) ORDER BY type, name`);
  if (rows.length !== 0) stop("PREWRITE_APPLICATION_SCHEMA_PRESENT", "reviewed application schema already exists");
}

async function assertMigrationBootstrapState(account, token) {
  const schemaRows = await select(account, token, "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = 'd1_migrations' OR tbl_name = 'd1_migrations' ORDER BY type, name");
  const classification = classifyD1MigrationBootstrapSchemaRows(schemaRows);
  if (!classification.valid) stop("PREWRITE_MIGRATION_HISTORY_SCHEMA_INVALID", "migration history schema is not the canonical Wrangler bootstrap state");
  if (!classification.present) return;

  const history = await select(account, token, "SELECT id, name, applied_at FROM d1_migrations ORDER BY id");
  if (history.length !== 0) stop("PREWRITE_MIGRATION_HISTORY_NOT_EMPTY", "migration history already contains applied migrations");
}

async function assertInitialUserSchemaEmpty(account, token) {
  const rows = await select(account, token, "SELECT type, name, tbl_name FROM sqlite_schema ORDER BY type, name");
  const classification = classifyInitialD1SchemaRows(rows);
  if (!classification.valid) stop("PREWRITE_SCHEMA_EVIDENCE_INVALID", "D1 schema evidence was malformed or unsupported");
  if (classification.unexpected.length !== 0) stop("PREWRITE_UNEXPECTED_USER_SCHEMA", "D1 contains unexpected application schema objects before first migration");
}

async function postVerify(account, token) {
  const history = await select(account, token, "SELECT name FROM d1_migrations ORDER BY id");
  if (history.length !== 1 || history[0]?.name !== MIGRATION) stop("POST_VERIFY_MIGRATION_HISTORY", "migration history mismatch");
  const rows = await select(account, token, `SELECT type, name, tbl_name FROM sqlite_schema WHERE name IN (${schemaSql(PROJECT_SCHEMA)}) ORDER BY type, name`);
  const actual = rows.map((r) => `${r?.type}:${r?.name}:${r?.tbl_name}`).sort();
  const expected = ["index:idx_webhook_deliveries_repository_updated_at:webhook_deliveries", "index:idx_webhook_deliveries_state_updated_at:webhook_deliveries", "table:d1_migrations:d1_migrations", "table:webhook_deliveries:webhook_deliveries"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) stop("POST_VERIFY_SCHEMA_INVALID", "reviewed project schema mismatch");
  const count = await select(account, token, "SELECT COUNT(*) AS row_count FROM webhook_deliveries");
  if (count.length !== 1 || Number(count[0]?.row_count) !== 0) stop("POST_VERIFY_DELIVERY_ROWS", "webhook_deliveries must be empty");
}

function plan() {
  console.log("MODE=PLAN");
  console.log(`HOST=${HOST}`);
  console.log(`ACCOUNT_ID=${ACCOUNT}`);
  console.log(`DATABASE_NAME=${DB_NAME}`);
  console.log(`DATABASE_UUID=${DB_ID}`);
  console.log(`DATABASE_JURISDICTION=${JURISDICTION}`);
  console.log(`MIGRATION=${MIGRATION}`);
  console.log(`MIGRATION_SHA256=${MIGRATION_SHA256}`);
  console.log(`NODE_MINIMUM=${NODE_MINIMUM}`);
  console.log(`WRANGLER=${WRANGLER_VERSION}`);
  console.log("PREWRITE_D1_VERIFICATION=GET_AND_SELECT_ONLY");
  console.log("PREWRITE_MIGRATION_BOOTSTRAP=ABSENT_OR_CANONICAL_EMPTY");
  console.log("PREWRITE_WRANGLER_MIGRATIONS_LIST=DISABLED");
  console.log("REMOTE_D1_MUTATION=NO");
  console.log(`OWNER_AUTHORIZATION_FORMAT=${AUTH_PREFIX}<exact-main-sha> ci <exact-ci-run-id>`);
  console.log("NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES");
  console.log("QUEUE_DLQ_WEBHOOK_WORKER_DEPLOY_TRAFFIC_ROUTING=NOT_AUTHORIZED");
}

async function apply(a) {
  assertInputs(a);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";
  if (account !== ACCOUNT) stop("ACCOUNT_ID_INVALID", "Cloudflare account does not match reviewed production account");
  if (!token) stop("CLOUDFLARE_API_TOKEN_REQUIRED", "temporary setup token is required");
  if (authorization !== `${AUTH_PREFIX}${a.sha} ci ${a.ci}`) stop("OWNER_AUTHORIZATION_INVALID", "one-shot authorization must match exact SHA and CI run");

  assertRepo(a.sha);
  await assertSource();
  await assertCi(a.sha, a.ci);
  run("npm", ["run", "check"], { inherit: true });
  await assertDb(account, token);
  await assertApplicationSchemaAbsent(account, token);
  await assertMigrationBootstrapState(account, token);
  await assertInitialUserSchemaEmpty(account, token);

  assertRepo(a.sha);
  await assertCi(a.sha, a.ci);
  await assertDb(account, token);
  await assertApplicationSchemaAbsent(account, token);
  await assertMigrationBootstrapState(account, token);
  await assertInitialUserSchemaEmpty(account, token);

  console.log("APPLY_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("NO_BLIND_RETRY_IF_STOP_AFTER_APPLY_STARTED=YES");

  const r = spawnSync(wrangler(), ["d1", "migrations", "apply", DB_NAME, "--remote", "--config", "wrangler.jsonc", "--experimental-provision=false", "--experimental-auto-create=false", "--install-skills=false"], {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
    env: cleanEnv({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account }),
  });
  if (r.error || r.status !== 0) {
    console.error("POST_APPLY_STATE=REVIEW_REQUIRED");
    stop("D1_MIGRATION_APPLY_FAILED", "apply failed or returned an ambiguous result; do not retry blindly");
  }
  try {
    await delay(1500);
    await assertDb(account, token);
    await postVerify(account, token);
  } catch (error) {
    console.error("POST_APPLY_STATE=REVIEW_REQUIRED");
    throw error;
  }
  console.log("REMOTE_D1_MIGRATION_GATE=PASS");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("MIGRATION_HISTORY=PROVEN");
  console.log("PENDING_MIGRATIONS=0_PROVEN_BY_SOURCE_HISTORY_MATCH");
  console.log("WEBHOOK_DELIVERIES_ROWS=0");
  console.log("QUEUE_DLQ_WEBHOOK_WORKER_DEPLOY_TRAFFIC_ROUTING=NOT_AUTHORIZED");
}

try {
  const a = args(process.argv.slice(2));
  if (a.mode === "plan") plan();
  else await apply(a);
} catch {
  if (process.exitCode !== 1) {
    console.error("STOP=UNEXPECTED_FAILURE");
    process.exitCode = 1;
  }
}
