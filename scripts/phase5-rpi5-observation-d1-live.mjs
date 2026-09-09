#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const REPO = "rozkalnsandris/rozkalns-control-center";
const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-d1-live.yml";
const PREFLIGHT_PATH = ".github/workflows/phase5-rpi5-observation-readonly-preflight.yml";
const EXPECTED_WORKFLOW_REF = `${REPO}/${WORKFLOW_PATH}@refs/heads/main`;
const CF_ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
const WORKER_NAME = "rozkalns-control";
const DB_NAME = "rozkalns-control-production";
const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
const DB_JURISDICTION = "eu";
const WRANGLER_VERSION = "4.120.0";
const SOURCE_MIGRATIONS = [
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
];
const PHASE5_MIGRATIONS = SOURCE_MIGRATIONS.slice(9);
const ALLOWED_CEILINGS = new Map([
  [PHASE5_MIGRATIONS.join(","), SOURCE_MIGRATIONS.slice(0, 9)],
  [PHASE5_MIGRATIONS.slice(1).join(","), SOURCE_MIGRATIONS.slice(0, 10)],
]);
let applyStarted = false;

function stop(code, message) {
  if (applyStarted) console.error("POST_APPLY_STATE=REVIEW_REQUIRED");
  console.error(`STOP=${code}`);
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
  throw new Error(code);
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_WORKERS_READ_TOKEN",
    "CLOUDFLARE_D1_READ_TOKEN",
    "CLOUDFLARE_D1_WRITE_TOKEN",
  ]) delete env[key];
  return { ...env, ...extra };
}

function run(command, args, { inherit = false, env = cleanEnv() } = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env,
  });
  if (result.error || result.status !== 0) stop("COMMAND_FAILED", `${command} exited ${result.status ?? "unknown"}`);
  return inherit ? "" : `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function wrangler() {
  return resolve("node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

function input(name) {
  return process.env[name] ?? "";
}

function expectedAuthorization(a) {
  return `AUTHORIZE LIVE PHASE5 D1 APPLY rozkalns-control-center source_sha=${a.sha} ci_run=${a.ciRun} preflight_run=${a.preflightRun} deployment=${a.deployment} version=${a.version} migrations=${a.migrations} db=${DB_NAME}`;
}

function inputs() {
  return {
    sha: input("APPROVED_SHA"),
    ciRun: input("EXPECTED_CI_RUN"),
    preflightRun: input("EXPECTED_PREFLIGHT_RUN"),
    deployment: input("EXPECTED_DEPLOYMENT"),
    version: input("EXPECTED_VERSION"),
    migrations: input("EXPECTED_MIGRATIONS"),
    database: input("EXPECTED_DATABASE"),
    authorization: input("OWNER_AUTHORIZATION"),
  };
}

function assertInputs(a) {
  if (!/^[0-9a-f]{40}$/.test(a.sha)) stop("APPROVED_SHA_INVALID", "approved SHA must be 40 lowercase hex characters");
  if (!/^[1-9][0-9]*$/.test(a.ciRun)) stop("EXPECTED_CI_RUN_INVALID", "CI run id must be positive");
  if (!/^[1-9][0-9]*$/.test(a.preflightRun)) stop("EXPECTED_PREFLIGHT_RUN_INVALID", "preflight run id must be positive");
  if (!/^[0-9a-f-]{36}$/.test(a.deployment)) stop("EXPECTED_DEPLOYMENT_INVALID", "deployment id must be a UUID");
  if (!/^[0-9a-f-]{36}$/.test(a.version)) stop("EXPECTED_VERSION_INVALID", "version id must be a UUID");
  if (a.database !== DB_NAME) stop("EXPECTED_DATABASE_INVALID", "database name does not match production target");
  if (!ALLOWED_CEILINGS.has(a.migrations)) stop("MIGRATION_CEILING_INVALID", "migration ceiling is not one of the reviewed non-empty Phase 5 apply sets");
  if (a.authorization !== expectedAuthorization(a)) stop("OWNER_AUTHORIZATION_INVALID", "owner authorization does not exactly bind the execution inputs");
}

function assertExecutionContext(a) {
  if (process.env.GITHUB_ACTIONS !== "true") stop("GITHUB_ACTIONS_REQUIRED", "D1 apply is GitHub-hosted only");
  if (process.env.GITHUB_RUN_ATTEMPT !== "1") stop("ACTIONS_RERUN_FORBIDDEN", "reruns are forbidden; obtain a fresh owner authorization event");
  const valid =
    process.env.GITHUB_REPOSITORY === REPO &&
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    process.env.GITHUB_REF === "refs/heads/main" &&
    process.env.GITHUB_REF_NAME === "main" &&
    process.env.GITHUB_SHA === a.sha &&
    process.env.GITHUB_WORKFLOW_REF === EXPECTED_WORKFLOW_REF &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
    process.env.RUNNER_OS === "Linux";
  if (!valid) stop("EXECUTION_CONTEXT_INVALID", "apply requires the exact default-branch workflow on a GitHub-hosted Linux runner");
}

function assertCredentialsPresent() {
  if (!input("GITHUB_TOKEN")) stop("GITHUB_TOKEN_REQUIRED", "GitHub read token is required");
  if (!input("CLOUDFLARE_WORKERS_READ_TOKEN")) stop("CLOUDFLARE_WORKERS_READ_TOKEN_REQUIRED", "Workers read token is required");
  if (!input("CLOUDFLARE_D1_READ_TOKEN")) stop("CLOUDFLARE_D1_READ_TOKEN_REQUIRED", "D1 read token is required");
  if (!input("CLOUDFLARE_D1_WRITE_TOKEN")) stop("CLOUDFLARE_D1_WRITE_TOKEN_REQUIRED", "dedicated D1 write token is required");
}

function assertRepo(a) {
  if (run("git", ["status", "--porcelain"]) !== "") stop("WORKTREE_DIRTY", "apply requires a clean checkout");
  if (run("git", ["rev-parse", "HEAD"]) !== a.sha) stop("HEAD_MISMATCH", "checked-out source differs from approved SHA");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== a.sha) stop("REMOTE_MAIN_MISMATCH", "origin/main moved from approved SHA");
}

async function assertSource() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.engines?.node !== "24.19.0" || pkg?.devEngines?.runtime?.version !== "24.19.0") {
    stop("NODE_PIN_INVALID", "canonical Node pin changed");
  }
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) stop("WRANGLER_PIN_INVALID", "Wrangler pin changed");
  const cfg = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const d1 = Array.isArray(cfg?.d1_databases) ? cfg.d1_databases : [];
  if (d1.length !== 1 || d1[0]?.binding !== "CONTROL_DB" || d1[0]?.database_name !== DB_NAME || d1[0]?.database_id !== DB_ID || d1[0]?.migrations_dir !== "migrations") {
    stop("D1_BINDING_INVALID", "production D1 binding changed");
  }
  const files = (await readdir("migrations", { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(files) !== JSON.stringify(SOURCE_MIGRATIONS)) stop("SOURCE_MIGRATION_SET_INVALID", "source migration set is not exactly 0001 through 0013");
  const version = run(wrangler(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "installed Wrangler does not match the reviewed pin");
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

async function gh(path) {
  return json(`https://api.github.com/repos/${REPO}${path}`, {
    headers: {
      Authorization: `Bearer ${input("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "rozkalns-control-phase5-d1-live",
    },
  }, "GITHUB_READ_FAILED");
}

async function cf(token, path, init = {}) {
  const payload = await json(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  }, "CLOUDFLARE_READ_FAILED");
  if (payload?.success !== true) stop("CLOUDFLARE_READ_INVALID", "Cloudflare response was unsuccessful");
  return payload.result;
}

async function d1Select(sql) {
  if (!/^SELECT\b/i.test(sql.trim()) || sql.includes(";")) stop("D1_QUERY_NOT_SELECT", "verification query must be one SELECT without semicolons");
  const result = await cf(input("CLOUDFLARE_D1_READ_TOKEN"), `/d1/database/${DB_ID}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0]?.results)) {
    stop("D1_SELECT_INVALID", "D1 SELECT result was unexpected");
  }
  if (result[0]?.meta?.changed_db === true || Number(result[0]?.meta?.rows_written ?? 0) !== 0 || Number(result[0]?.meta?.changes ?? 0) !== 0) {
    stop("D1_SELECT_REPORTED_MUTATION", "read-only verification reported a write");
  }
  return result[0].results;
}

async function assertGitHubEvidence(a) {
  const main = await gh("/branches/main");
  if (main?.commit?.sha !== a.sha) stop("MAIN_SHA_DRIFT", "current main differs from approved SHA");
  const ci = await gh(`/actions/runs/${a.ciRun}`);
  if (ci?.name !== "CI" || ci?.path !== ".github/workflows/ci.yml" || ci?.head_branch !== "main" || ci?.head_sha !== a.sha || ci?.event !== "push" || ci?.status !== "completed" || ci?.conclusion !== "success") {
    stop("CI_GATE_INVALID", "named CI run is not successful exact-main push CI");
  }
  const preflight = await gh(`/actions/runs/${a.preflightRun}`);
  if (preflight?.name !== "Phase 5 RPi5 observation GET/SELECT-only preflight" || preflight?.path !== PREFLIGHT_PATH || preflight?.head_branch !== "main" || preflight?.head_sha !== a.sha || preflight?.event !== "workflow_dispatch" || preflight?.status !== "completed" || preflight?.conclusion !== "success" || preflight?.run_attempt !== 1) {
    stop("PREFLIGHT_GATE_INVALID", "named preflight is not a successful first-attempt exact-main run");
  }
}

async function assertWorkerBaseline(a) {
  const deployments = await cf(input("CLOUDFLARE_WORKERS_READ_TOKEN"), `/workers/scripts/${WORKER_NAME}/deployments`);
  const current = deployments?.deployments?.[0];
  if (!current || current.id !== a.deployment || !Array.isArray(current.versions) || current.versions.length !== 1 || current.versions[0]?.version_id !== a.version || current.versions[0]?.percentage !== 100) {
    stop("WORKER_BASELINE_DRIFT", "active deployment/version/traffic differs from the authorized baseline");
  }
  const version = await cf(input("CLOUDFLARE_WORKERS_READ_TOKEN"), `/workers/scripts/${WORKER_NAME}/versions/${a.version}`);
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  const db = bindings.filter((binding) => binding?.name === "CONTROL_DB");
  if (db.length !== 1 || db[0]?.type !== "d1" || (db[0]?.database_id ?? db[0]?.id ?? "") !== DB_ID) stop("CONTROL_DB_BINDING_DRIFT", "Worker CONTROL_DB binding changed");
  if (bindings.some((binding) => binding?.name === "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED")) stop("INGEST_BASELINE_DRIFT", "D1 apply requires the pre-key dormant baseline with ingest binding absent");
  if (bindings.some((binding) => binding?.name === "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS")) stop("VERIFICATION_KEY_BASELINE_DRIFT", "D1 apply requires verification-key binding absent");
}

async function assertDbIdentityWithToken(token, code) {
  const db = await cf(token, `/d1/database/${DB_ID}`);
  if (db?.uuid !== DB_ID || db?.name !== DB_NAME || db?.jurisdiction !== DB_JURISDICTION) stop(code, "D1 identity does not match the reviewed production target");
}

function requireExactHistory(rows, expected, code) {
  const names = rows.map((row) => row?.name);
  const ids = rows.map((row) => row?.id);
  if (JSON.stringify(names) !== JSON.stringify(expected)) stop(code, `migration history must equal ${expected.join(",")}`);
  if (ids.some((id) => typeof id !== "number" || !Number.isInteger(id)) || ids.some((id, index) => index > 0 && id <= ids[index - 1])) {
    stop(code, "migration ids must be strictly increasing integers");
  }
}

function normalizeSql(sql) {
  return String(sql ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function assertIndex(expectedPresent) {
  const rows = await d1Select("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name = 'idx_webhook_deliveries_active_updated_delivery'");
  if (!expectedPresent) {
    if (rows.length !== 0) stop("D1_0010_INDEX_PRESENT_UNEXPECTEDLY", "0010 index exists before authorized apply");
    return;
  }
  const expected = "create index idx_webhook_deliveries_active_updated_delivery on webhook_deliveries (updated_at, delivery_id) where state <> 'succeeded'";
  if (rows.length !== 1 || rows[0]?.type !== "index" || rows[0]?.name !== "idx_webhook_deliveries_active_updated_delivery" || rows[0]?.tbl_name !== "webhook_deliveries" || normalizeSql(rows[0]?.sql) !== expected) {
    stop("D1_0010_INDEX_INVALID", "0010 index is missing or does not match reviewed SQL");
  }
}

async function assertPhase5TablesAbsent() {
  const rows = await d1Select("SELECT type, name, tbl_name FROM sqlite_schema WHERE name IN ('rpi5_observation_replay_claims','rpi5_production_visibility') ORDER BY name");
  if (rows.length !== 0) stop("PHASE5_SCHEMA_PRESENT_BEFORE_APPLY", "Phase 5 tables already exist before authorized apply");
}

async function assertPrewriteD1(a) {
  await assertDbIdentityWithToken(input("CLOUDFLARE_D1_READ_TOKEN"), "D1_RESOURCE_IDENTITY_INVALID");
  await assertDbIdentityWithToken(input("CLOUDFLARE_D1_WRITE_TOKEN"), "D1_WRITE_CREDENTIAL_TARGET_INVALID");
  const expectedPrefix = ALLOWED_CEILINGS.get(a.migrations);
  const history = await d1Select("SELECT id, name FROM d1_migrations ORDER BY id");
  requireExactHistory(history, expectedPrefix, "PREWRITE_MIGRATION_HISTORY_INVALID");
  await assertIndex(expectedPrefix.includes("0010_webhook_observability_hot_index.sql"));
  await assertPhase5TablesAbsent();
}

async function assertPostwriteD1() {
  await assertDbIdentityWithToken(input("CLOUDFLARE_D1_READ_TOKEN"), "POST_D1_RESOURCE_IDENTITY_INVALID");
  const history = await d1Select("SELECT id, name FROM d1_migrations ORDER BY id");
  requireExactHistory(history, SOURCE_MIGRATIONS, "POST_MIGRATION_HISTORY_INVALID");
  await assertIndex(true);
  const schema = await d1Select("SELECT type, name, tbl_name FROM sqlite_schema WHERE name IN ('rpi5_observation_replay_claims','rpi5_production_visibility') ORDER BY name");
  const expected = [
    { type: "table", name: "rpi5_observation_replay_claims", tbl_name: "rpi5_observation_replay_claims" },
    { type: "table", name: "rpi5_production_visibility", tbl_name: "rpi5_production_visibility" },
  ];
  if (JSON.stringify(schema.map(({ type, name, tbl_name }) => ({ type, name, tbl_name }))) !== JSON.stringify(expected)) stop("POST_PHASE5_SCHEMA_INVALID", "Phase 5 tables are missing or malformed");
  await d1Select("SELECT replay_key, replay_expires_at_ms, claimed_at_ms, claim_token FROM rpi5_observation_replay_claims LIMIT 0");
  await d1Select("SELECT project_id, repository, main_sha, production_sha, observed_at_ms, stored_at_ms FROM rpi5_production_visibility LIMIT 0");
  const replayCount = await d1Select("SELECT COUNT(*) AS row_count FROM rpi5_observation_replay_claims");
  const projectionCount = await d1Select("SELECT COUNT(*) AS row_count FROM rpi5_production_visibility");
  if (Number(replayCount[0]?.row_count ?? -1) !== 0 || Number(projectionCount[0]?.row_count ?? -1) !== 0) stop("POST_PHASE5_ROWS_NOT_EMPTY", "new Phase 5 tables must be empty before ingest activation");
}

async function assertAllPrewrite(a) {
  assertRepo(a);
  await assertSource();
  await assertGitHubEvidence(a);
  await assertWorkerBaseline(a);
  await assertPrewriteD1(a);
}

async function main() {
  const a = inputs();
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
  console.log("MUTATION_CLASS=D1_APPLY_ONLY");
  console.log("NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES");

  const result = spawnSync(wrangler(), [
    "d1", "migrations", "apply", DB_NAME, "--remote",
    "--config", "wrangler.jsonc",
    "--experimental-provision=false",
    "--experimental-auto-create=false",
    "--install-skills=false",
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
    env: cleanEnv({
      CLOUDFLARE_API_TOKEN: input("CLOUDFLARE_D1_WRITE_TOKEN"),
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
    }),
  });
  if (result.error || result.status !== 0) stop("D1_MIGRATION_APPLY_FAILED", "Wrangler apply failed or returned an ambiguous result; do not retry");

  console.log("STAGE=POSTWRITE_READONLY_VERIFICATION");
  await assertPostwriteD1();
  console.log("REMOTE_D1_MIGRATION_GATE=PASS");
  console.log("MIGRATION_HISTORY=0001_THROUGH_0013_EXACT");
  console.log("PENDING_PHASE5_MIGRATIONS=0");
  console.log("PHASE5_NEW_TABLE_ROWS=0");
  console.log("WORKER_MUTATION=NO");
  console.log("QUEUE_MUTATION=NO");
  console.log("SECRET_MUTATION=NO");
  console.log("RPI5_REQUEST=NO");
}

try {
  await main();
} catch {
  if (process.exitCode !== 1) {
    if (applyStarted) console.error("POST_APPLY_STATE=REVIEW_REQUIRED");
    console.error("STOP=UNEXPECTED_FAILURE");
    process.exitCode = 1;
  }
}
