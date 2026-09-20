#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "rozkalnsandris/rozkalns-control-center";
export const WORKFLOW_PATH = ".github/workflows/continuation-d1-0014-live.yml";
export const PREFLIGHT_PATH = ".github/workflows/owner-panel-readonly-preflight.yml";
export const EXPECTED_WORKFLOW_REF = `${REPO}/${WORKFLOW_PATH}@refs/heads/main`;
export const DB_NAME = "rozkalns-control-production";
export const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
export const DB_JURISDICTION = "eu";
export const CF_ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
export const WRANGLER_VERSION = "4.120.0";
export const MIGRATION = "0014_continuation_action_audit.sql";
export const MIGRATION_SHA256 = "b3249d6106a484ddc7eb0a3cc2e1c7942fb8b3a4c4956698c7ebc8c58eea9275";
export const SOURCE_MIGRATIONS = [
  "0001_reconciliation_core.sql",
  "0002_needs_changes_audit.sql",
  "0003_notification_transitions.sql",
  "0004_notification_delivery_intents.sql",
  "0005_notification_delivery_attempts.sql",
  "0006_notification_delivery_dispatch_claims.sql",
  "0007_continuation_campaigns.sql",
  "0008_merge_decision_audit.sql",
  "0009_later_deferrals.sql",
  "0010_webhook_observability_hot_index.sql",
  "0011_rpi5_observation_replay_claims.sql",
  "0012_rpi5_production_visibility_projection.sql",
  "0013_rpi5_observation_atomic_acceptance.sql",
  MIGRATION,
];
export const PREDECESSOR_MIGRATIONS = SOURCE_MIGRATIONS.slice(0, -1);
let applyStarted = false;

function input(name) {
  return process.env[name] ?? "";
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeSql(sql) {
  return String(sql ?? "").trim().replace(/;+\s*$/, "").toLowerCase().replace(/\s+/g, " ");
}

export function expectedAuthorization(a) {
  return `AUTHORIZE LIVE CONTINUATION D1 0014 APPLY rozkalns-control-center source_sha=${a.sha} ci_run=${a.ciRun} preflight_run=${a.preflightRun} migration_sha256=${a.migrationSha256} db=${DB_NAME} POST1 NO_RETRY NO_ROLLBACK NO_CLEANUP`;
}

export function parseInputs(env = process.env) {
  return {
    sha: env.APPROVED_SHA ?? "",
    ciRun: env.EXPECTED_CI_RUN ?? "",
    preflightRun: env.EXPECTED_PREFLIGHT_RUN ?? "",
    migrationSha256: env.EXPECTED_MIGRATION_SHA256 ?? "",
    database: env.EXPECTED_DATABASE ?? "",
    authorization: env.OWNER_AUTHORIZATION ?? "",
  };
}

function fail(code, message) {
  if (applyStarted) console.error("POST_APPLY_STATE=REVIEW_REQUIRED");
  console.error(`STOP=${code}`);
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
  throw new Error(code);
}

export function assertInputs(a) {
  if (!/^[0-9a-f]{40}$/.test(a.sha)) fail("APPROVED_SHA_INVALID", "approved SHA must be exact lowercase hex");
  if (!/^[1-9][0-9]*$/.test(a.ciRun)) fail("EXPECTED_CI_RUN_INVALID", "CI run id must be positive");
  if (!/^[1-9][0-9]*$/.test(a.preflightRun)) fail("EXPECTED_PREFLIGHT_RUN_INVALID", "preflight run id must be positive");
  if (a.migrationSha256 !== MIGRATION_SHA256) fail("MIGRATION_SHA256_INVALID", "migration digest does not match reviewed source");
  if (a.database !== DB_NAME) fail("EXPECTED_DATABASE_INVALID", "database does not match fixed production target");
  if (a.authorization !== expectedAuthorization(a)) fail("OWNER_AUTHORIZATION_INVALID", "owner authorization does not exactly bind execution inputs");
}

export function requireExactHistory(rows, expected, code = "MIGRATION_HISTORY_INVALID") {
  const names = rows.map((row) => row?.name);
  const ids = rows.map((row) => row?.id);
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail(code, "migration history differs from the exact reviewed sequence");
  if (ids.some((id) => typeof id !== "number" || !Number.isInteger(id)) || ids.some((id, i) => i > 0 && id <= ids[i - 1])) {
    fail(code, "migration ids must be strictly increasing integers");
  }
}

export function inventoryStepPassed(jobs) {
  const steps = Array.isArray(jobs) ? jobs.flatMap((job) => Array.isArray(job?.steps) ? job.steps : []) : [];
  return steps.filter((step) => step?.name === "Fixed-target read-only inventory" && step?.status === "completed" && step?.conclusion === "success").length === 1;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_READ_TOKEN", "CLOUDFLARE_D1_WRITE_TOKEN"]) delete env[key];
  return { ...env, ...extra };
}

function run(command, args, { inherit = false, env = cleanEnv() } = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env,
  });
  if (result.error || result.status !== 0) fail("COMMAND_FAILED", `${command} exited ${result.status ?? "unknown"}`);
  return inherit ? "" : `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function wrangler() {
  return resolve("node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

function assertExecutionContext(a) {
  if (process.env.GITHUB_ACTIONS !== "true") fail("GITHUB_ACTIONS_REQUIRED", "D1 apply is GitHub-hosted only");
  if (process.env.GITHUB_RUN_ATTEMPT !== "1") fail("ACTIONS_RERUN_FORBIDDEN", "reruns require a fresh owner authorization event");
  const valid = process.env.GITHUB_REPOSITORY === REPO &&
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    process.env.GITHUB_REF === "refs/heads/main" &&
    process.env.GITHUB_REF_NAME === "main" &&
    process.env.GITHUB_SHA === a.sha &&
    process.env.GITHUB_WORKFLOW_REF === EXPECTED_WORKFLOW_REF &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_OS === "Linux";
  if (!valid) fail("EXECUTION_CONTEXT_INVALID", "apply requires the exact default-branch workflow on GitHub-hosted Linux");
}

function assertCredentialsPresent() {
  if (!input("GITHUB_TOKEN")) fail("GITHUB_TOKEN_REQUIRED", "GitHub read token is required");
  if (!input("CLOUDFLARE_D1_READ_TOKEN")) fail("CLOUDFLARE_D1_READ_TOKEN_REQUIRED", "D1 read token is required");
  if (!input("CLOUDFLARE_D1_WRITE_TOKEN")) fail("CLOUDFLARE_D1_WRITE_TOKEN_REQUIRED", "dedicated D1 write token is required");
}

function assertRepo(a) {
  if (run("git", ["status", "--porcelain"]) !== "") fail("WORKTREE_DIRTY", "apply requires a clean checkout");
  if (run("git", ["rev-parse", "HEAD"]) !== a.sha) fail("HEAD_MISMATCH", "checked-out source differs from approved SHA");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== a.sha) fail("REMOTE_MAIN_MISMATCH", "origin/main moved from approved SHA");
}

async function assertSource(a) {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.engines?.node !== "24.19.0" || pkg?.devEngines?.runtime?.version !== "24.19.0") fail("NODE_PIN_INVALID", "canonical Node pin changed");
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) fail("WRANGLER_PIN_INVALID", "Wrangler pin changed");
  const cfg = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const d1 = Array.isArray(cfg?.d1_databases) ? cfg.d1_databases : [];
  if (d1.length !== 1 || d1[0]?.binding !== "CONTROL_DB" || d1[0]?.database_name !== DB_NAME || d1[0]?.database_id !== DB_ID || d1[0]?.migrations_dir !== "migrations") fail("D1_BINDING_INVALID", "production D1 binding changed");
  const files = (await readdir("migrations", { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => e.name).sort();
  if (JSON.stringify(files) !== JSON.stringify(SOURCE_MIGRATIONS)) fail("SOURCE_MIGRATION_SET_INVALID", "source migration set is not exactly 0001 through 0014");
  const migration = await readFile(`migrations/${MIGRATION}`);
  if (sha256(migration) !== MIGRATION_SHA256 || a.migrationSha256 !== MIGRATION_SHA256) fail("SOURCE_0014_DIGEST_INVALID", "0014 source digest changed");
  const sql = migration.toString("utf8");
  if (!sql.includes("CREATE TABLE continuation_action_audit") || /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(sql)) fail("SOURCE_0014_SCOPE_INVALID", "0014 must contain only the reviewed CREATE TABLE scope");
  const version = run(wrangler(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) fail("WRANGLER_VERSION_INVALID", "installed Wrangler does not match reviewed pin");
}

async function json(url, options, code) {
  let response;
  try { response = await fetch(url, options); } catch { fail(code, "network request failed"); }
  if (!response.ok) fail(code, `HTTP ${response.status}`);
  try { return await response.json(); } catch { fail(code, "response was not valid JSON"); }
}

async function gh(path) {
  return json(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { Authorization: `Bearer ${input("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "rozkalns-control-continuation-d1-0014" },
  }, "GITHUB_READ_FAILED");
}

async function cf(token, path, init = {}) {
  const payload = await json(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.headers ?? {}) },
  }, "CLOUDFLARE_READ_FAILED");
  if (payload?.success !== true) fail("CLOUDFLARE_READ_INVALID", "Cloudflare response was unsuccessful");
  return payload.result;
}

async function d1Select(sql) {
  if (!/^SELECT\b/i.test(sql.trim()) || sql.includes(";")) fail("D1_QUERY_NOT_SELECT", "verification query must be one SELECT without semicolons");
  const result = await cf(input("CLOUDFLARE_D1_READ_TOKEN"), `/d1/database/${DB_ID}/query`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }),
  });
  if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0]?.results)) fail("D1_SELECT_INVALID", "D1 SELECT result was unexpected");
  if (result[0]?.meta?.changed_db === true || Number(result[0]?.meta?.rows_written ?? 0) !== 0 || Number(result[0]?.meta?.changes ?? 0) !== 0) fail("D1_SELECT_REPORTED_MUTATION", "read-only verification reported a write");
  return result[0].results;
}

async function assertGitHubEvidence(a) {
  const main = await gh("/branches/main");
  if (main?.commit?.sha !== a.sha) fail("MAIN_SHA_DRIFT", "current main differs from approved SHA");
  const ci = await gh(`/actions/runs/${a.ciRun}`);
  if (ci?.name !== "CI" || ci?.path !== ".github/workflows/ci.yml" || ci?.head_branch !== "main" || ci?.head_sha !== a.sha || ci?.event !== "push" || ci?.status !== "completed" || ci?.conclusion !== "success") fail("CI_GATE_INVALID", "named CI run is not successful exact-main push CI");
  const preflight = await gh(`/actions/runs/${a.preflightRun}`);
  if (preflight?.name !== "Owner Action Panel read-only preflight" || preflight?.path !== PREFLIGHT_PATH || preflight?.head_branch !== "main" || preflight?.head_sha !== a.sha || preflight?.event !== "workflow_dispatch" || preflight?.status !== "completed" || preflight?.conclusion !== "success" || preflight?.run_attempt !== 1) fail("PREFLIGHT_GATE_INVALID", "named preflight is not a successful first-attempt exact-main owner-panel run");
  const jobs = await gh(`/actions/runs/${a.preflightRun}/jobs?per_page=100`);
  if (!inventoryStepPassed(jobs?.jobs)) fail("PREFLIGHT_INVENTORY_NOT_PROVEN", "named run did not successfully execute the fixed-target inventory step");
}

async function assertDbIdentityWithToken(token, code) {
  const db = await cf(token, `/d1/database/${DB_ID}`);
  if (db?.uuid !== DB_ID || db?.name !== DB_NAME || db?.jurisdiction !== DB_JURISDICTION) fail(code, "D1 identity does not match the reviewed production target");
}

async function assertPrewriteD1() {
  await assertDbIdentityWithToken(input("CLOUDFLARE_D1_READ_TOKEN"), "D1_RESOURCE_IDENTITY_INVALID");
  await assertDbIdentityWithToken(input("CLOUDFLARE_D1_WRITE_TOKEN"), "D1_WRITE_CREDENTIAL_TARGET_INVALID");
  const history = await d1Select("SELECT id, name FROM d1_migrations ORDER BY id");
  requireExactHistory(history, PREDECESSOR_MIGRATIONS, "PREWRITE_MIGRATION_HISTORY_INVALID");
  const schema = await d1Select("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = 'continuation_action_audit'");
  if (schema.length !== 0) fail("PREWRITE_0014_SCHEMA_PRESENT", "continuation_action_audit already exists before authorized apply");
}

async function expectedTableSql() {
  const source = (await readFile(`migrations/${MIGRATION}`, "utf8"));
  const at = source.indexOf("CREATE TABLE continuation_action_audit");
  if (at < 0) fail("SOURCE_0014_SCHEMA_INVALID", "reviewed table statement missing");
  return normalizeSql(source.slice(at));
}

async function assertPostwriteD1() {
  await assertDbIdentityWithToken(input("CLOUDFLARE_D1_READ_TOKEN"), "POST_D1_RESOURCE_IDENTITY_INVALID");
  const history = await d1Select("SELECT id, name FROM d1_migrations ORDER BY id");
  requireExactHistory(history, SOURCE_MIGRATIONS, "POST_MIGRATION_HISTORY_INVALID");
  const rows = await d1Select("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = 'continuation_action_audit'");
  if (rows.length !== 1 || rows[0]?.type !== "table" || rows[0]?.name !== "continuation_action_audit" || rows[0]?.tbl_name !== "continuation_action_audit" || normalizeSql(rows[0]?.sql) !== await expectedTableSql()) fail("POST_0014_SCHEMA_INVALID", "continuation_action_audit does not exactly match reviewed source");
  await d1Select("SELECT request_id, fingerprint, campaign_id, repository, action, actor_subject, actor_email, expected_main_sha, expected_revision, requested_at, result, result_revision FROM continuation_action_audit LIMIT 0");
  const count = await d1Select("SELECT COUNT(*) AS row_count FROM continuation_action_audit");
  if (Number(count[0]?.row_count ?? -1) !== 0) fail("POST_0014_ROWS_NOT_EMPTY", "new audit table must be empty immediately after migration");
}

async function assertAllPrewrite(a) {
  assertRepo(a);
  await assertSource(a);
  await assertGitHubEvidence(a);
  await assertPrewriteD1();
}

export async function main() {
  const a = parseInputs();
  assertInputs(a);
  assertExecutionContext(a);
  assertCredentialsPresent();

  console.log("STAGE=PREWRITE_REVALIDATION_1");
  await assertAllPrewrite(a);
  console.log("STAGE=PREWRITE_REVALIDATION_FINAL");
  await assertAllPrewrite(a);

  applyStarted = true;
  console.log("APPLY_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("MUTATION_CLASS=CONTINUATION_D1_0014_ONLY");
  console.log("NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES");

  const result = spawnSync(wrangler(), [
    "d1", "migrations", "apply", DB_NAME, "--remote", "--config", "wrangler.jsonc",
    "--experimental-provision=false", "--experimental-auto-create=false", "--install-skills=false",
  ], {
    cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"],
    env: cleanEnv({ CLOUDFLARE_API_TOKEN: input("CLOUDFLARE_D1_WRITE_TOKEN"), CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID }),
  });
  if (result.error || result.status !== 0) fail("D1_MIGRATION_APPLY_FAILED", "Wrangler apply failed or returned an ambiguous result; do not retry");

  console.log("STAGE=POSTWRITE_READONLY_VERIFICATION");
  await assertPostwriteD1();
  console.log("CONTINUATION_D1_0014=PASS");
  console.log("MIGRATION_HISTORY=0001_THROUGH_0014_EXACT");
  console.log("CONTINUATION_ACTION_AUDIT_ROWS=0");
  console.log("WORKER_MUTATION=NO");
  console.log("ACCESS_MUTATION=NO");
  console.log("QUEUE_MUTATION=NO");
  console.log("SECRET_MUTATION=NO");
  console.log("RPI5_REQUEST=NO");
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntry) {
  try { await main(); } catch {
    if (process.exitCode !== 1) {
      if (applyStarted) console.error("POST_APPLY_STATE=REVIEW_REQUIRED");
      console.error("STOP=UNEXPECTED_FAILURE");
      process.exitCode = 1;
    }
  }
}
