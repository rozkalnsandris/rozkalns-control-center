#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkGitAncestor } from "./phase5-git-provenance.mjs";
import { emitWranglerFailureDiagnostics } from "./phase5-worker-wrangler-diagnostics.mjs";

const REPO = "rozkalnsandris/rozkalns-control-center";
const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-worker-activate-live.yml";
const PREFLIGHT_PATH = ".github/workflows/phase5-rpi5-observation-readonly-preflight.yml";
const PROVISION_PATH = ".github/workflows/phase5-rpi5-observation-verification-key-live.yml";
const EXPECTED_WORKFLOW_REF = `${REPO}/${WORKFLOW_PATH}@refs/heads/main`;

const CF_ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
const WORKER_NAME = "rozkalns-control";
const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
const DB_NAME = "rozkalns-control-production";
const DB_JURISDICTION = "eu";
const INGEST_BINDING = "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED";
const KEY_BINDING = "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS";
const CANDIDATE_CONTRACT = "PHASE5_RPI5_OBSERVATION_WORKER_ACTIVATION_CANDIDATE_V1";
const NODE_VERSION = "24.19.0";
const WRANGLER_VERSION = "4.120.0";
const VERSION_STRATEGY = "UPLOAD_NEW_VERSION_THEN_GET_VERIFY_THEN_DEPLOY_EXACT_VERSION_100_PERCENT";

const ALLOWED_DELTAS = [
  "CREATE_ONE_NEW_WORKER_VERSION_FROM_EXACT_SOURCE_AND_CANDIDATE_CONFIG",
  "ADD_OR_SET_CONTROL_RPI5_OBSERVATION_INGEST_ENABLED_TO_PLAIN_TEXT_TRUE",
  "DEPLOY_ONLY_THE_EXACT_VERIFIED_UPLOADED_VERSION_AT_100_PERCENT",
];

const FORBIDDEN_DELTAS = [
  "VERIFICATION_KEY_BINDING_OR_VALUE_CHANGE",
  "CONTROL_DB_BINDING_OR_RESOURCE_CHANGE",
  "NON_TARGET_BINDING_CHANGE",
  "ROUTE_OR_CUSTOM_DOMAIN_CHANGE",
  "TRIGGER_OR_QUEUE_CHANGE",
  "D1_MUTATION",
  "SECRET_OR_CREDENTIAL_MUTATION",
  "CLOUDFLARE_ACCOUNT_OR_ACCESS_DNS_TUNNEL_CHANGE",
  "RPI5_MUTATION",
  "CROSS_CLASS_CASCADE",
];

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

let mutationStarted = false;
let uploadedVersion = "";

function stop(code, message) {
  if (mutationStarted) {
    console.error("POST_MUTATION_STATE=REVIEW_REQUIRED");
    console.error("AUTHORIZATION_CONSUMED=YES");
    console.error("NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES");
    console.error(`UPLOADED_VERSION=${uploadedVersion || "UNKNOWN"}`);
  } else {
    console.error("AUTHORIZATION_CONSUMED=NO");
  }
  console.error(`STOP=${code}`);
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
  throw new Error(code);
}

function input(name) {
  return process.env[name] ?? "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function wrangler() {
  return resolve("node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_WORKERS_READ_TOKEN",
    "CLOUDFLARE_D1_READ_TOKEN",
    "CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN",
    "CANDIDATE_MANIFEST_JSON",
    "OWNER_AUTHORIZATION",
  ]) delete env[key];
  return { ...env, ...extra };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv(),
  });
  if (result.error || result.status !== 0) {
    stop("COMMAND_FAILED", `${command} exited ${result.status ?? "unknown"}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function exactArray(value, expected) {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function parseCandidate(raw) {
  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch {
    stop("CANDIDATE_JSON_INVALID", "candidate manifest is not valid JSON");
  }

  if (!exactKeys(candidate, [
    "schema_version", "contract", "repository", "worker", "source_sha", "ci_run_id",
    "preflight_run_id", "source_config_sha256", "toolchain", "expected_current",
    "intended_result", "allowed_deltas", "forbidden_deltas", "one_shot",
  ])) {
    stop("CANDIDATE_SHAPE_INVALID", "candidate top-level fields drifted");
  }

  if (
    candidate.schema_version !== 1 ||
    candidate.contract !== CANDIDATE_CONTRACT ||
    candidate.repository !== REPO ||
    candidate.worker !== WORKER_NAME
  ) {
    stop("CANDIDATE_IDENTITY_INVALID", "candidate schema/contract/repository/worker mismatch");
  }

  if (
    !SHA1.test(candidate.source_sha) ||
    !RUN_ID.test(candidate.ci_run_id) ||
    !RUN_ID.test(candidate.preflight_run_id) ||
    !SHA256.test(candidate.source_config_sha256)
  ) {
    stop("CANDIDATE_SOURCE_IDENTITY_INVALID", "candidate source identity is malformed");
  }

  if (
    !exactKeys(candidate.toolchain, ["node_version", "wrangler_version"]) ||
    candidate.toolchain.node_version !== NODE_VERSION ||
    candidate.toolchain.wrangler_version !== WRANGLER_VERSION
  ) {
    stop("CANDIDATE_TOOLCHAIN_INVALID", "candidate toolchain does not match reviewed pins");
  }

  const current = candidate.expected_current;
  if (!exactKeys(current, [
    "deployment_id", "version_id", "traffic_percent", "ingest_binding_state",
    "verification_key_prerequisite", "d1_prerequisite", "non_target_bindings_sha256",
  ])) {
    stop("CANDIDATE_BASELINE_SHAPE_INVALID", "candidate baseline fields drifted");
  }

  if (
    !UUID.test(current.deployment_id) ||
    !UUID.test(current.version_id) ||
    current.traffic_percent !== 100 ||
    !["ABSENT", "PRESENT_FALSE"].includes(current.ingest_binding_state) ||
    !SHA256.test(current.non_target_bindings_sha256)
  ) {
    stop("CANDIDATE_BASELINE_INVALID", "candidate baseline identity is invalid");
  }

  const key = current.verification_key_prerequisite;
  if (
    !exactKeys(key, ["binding", "type", "state", "key_id", "provision_run_id", "value_observed"]) ||
    key.binding !== KEY_BINDING ||
    key.type !== "secret_text" ||
    key.state !== "PRESENT_PROTECTED" ||
    !KEY_ID.test(key.key_id) ||
    !RUN_ID.test(key.provision_run_id) ||
    key.value_observed !== false
  ) {
    stop("CANDIDATE_KEY_PREREQUISITE_INVALID", "candidate protected verification-key prerequisite is invalid");
  }

  const d1 = current.d1_prerequisite;
  if (
    !exactKeys(d1, ["binding", "database_id", "migration_state"]) ||
    d1.binding !== "CONTROL_DB" ||
    d1.database_id !== DB_ID ||
    d1.migration_state !== "PRESENT_VALID_0010_THROUGH_0013"
  ) {
    stop("CANDIDATE_D1_PREREQUISITE_INVALID", "candidate D1 prerequisite is invalid");
  }

  const intended = candidate.intended_result;
  if (
    !exactKeys(intended, [
      "version_strategy", "ingest_binding", "verification_key_binding", "d1_binding",
      "non_target_bindings_sha256", "routes", "custom_domains", "triggers",
    ]) ||
    intended.version_strategy !== VERSION_STRATEGY
  ) {
    stop("CANDIDATE_RESULT_INVALID", "candidate version strategy drifted");
  }

  if (
    !exactKeys(intended.ingest_binding, ["name", "type", "value"]) ||
    intended.ingest_binding.name !== INGEST_BINDING ||
    intended.ingest_binding.type !== "plain_text" ||
    intended.ingest_binding.value !== "true"
  ) {
    stop("CANDIDATE_INGEST_DELTA_INVALID", "candidate ingest delta is not exact plain-text true");
  }

  if (
    !exactKeys(intended.verification_key_binding, ["name", "type", "state", "key_id", "value_observed"]) ||
    intended.verification_key_binding.name !== KEY_BINDING ||
    intended.verification_key_binding.type !== "secret_text" ||
    intended.verification_key_binding.state !== "PRESENT_PROTECTED_UNCHANGED" ||
    intended.verification_key_binding.key_id !== key.key_id ||
    intended.verification_key_binding.value_observed !== false
  ) {
    stop("CANDIDATE_KEY_RESULT_INVALID", "candidate verification-key result is not unchanged/protected");
  }

  if (
    !exactKeys(intended.d1_binding, ["name", "database_id", "state"]) ||
    intended.d1_binding.name !== "CONTROL_DB" ||
    intended.d1_binding.database_id !== DB_ID ||
    intended.d1_binding.state !== "UNCHANGED"
  ) {
    stop("CANDIDATE_D1_RESULT_INVALID", "candidate D1 result is not unchanged");
  }

  if (
    intended.non_target_bindings_sha256 !== current.non_target_bindings_sha256 ||
    intended.routes !== "UNCHANGED" ||
    intended.custom_domains !== "UNCHANGED" ||
    intended.triggers !== "UNCHANGED"
  ) {
    stop("CANDIDATE_NON_TARGET_RESULT_INVALID", "candidate non-target result drifted");
  }

  if (!exactArray(candidate.allowed_deltas, ALLOWED_DELTAS) || !exactArray(candidate.forbidden_deltas, FORBIDDEN_DELTAS)) {
    stop("CANDIDATE_DELTA_LIST_INVALID", "candidate delta lists drifted");
  }

  if (
    !exactKeys(candidate.one_shot, [
      "authorization_consumed_at", "cross_class_cascade",
      "automatic_retry_rollback_cleanup_or_alternate_mutation", "after_upload_mismatch",
      "post_deploy_verification",
    ]) ||
    candidate.one_shot.authorization_consumed_at !== "FIRST_WORKER_VERSION_UPLOAD" ||
    candidate.one_shot.cross_class_cascade !== false ||
    candidate.one_shot.automatic_retry_rollback_cleanup_or_alternate_mutation !== false ||
    candidate.one_shot.after_upload_mismatch !== "STOP_NO_DEPLOY" ||
    candidate.one_shot.post_deploy_verification !== "GET_ONLY_EXACT_ACTIVE_VERSION_TRAFFIC_BINDINGS_AND_ROUTE_STATE"
  ) {
    stop("CANDIDATE_ONE_SHOT_INVALID", "candidate one-shot semantics drifted");
  }

  return candidate;
}

function inputs() {
  return {
    sha: input("APPROVED_SHA"),
    ciRun: input("EXPECTED_CI_RUN"),
    preflightRun: input("EXPECTED_PREFLIGHT_RUN"),
    deployment: input("EXPECTED_DEPLOYMENT"),
    version: input("EXPECTED_VERSION"),
    candidateSha256: input("EXPECTED_CANDIDATE_SHA256"),
    candidateRaw: input("CANDIDATE_MANIFEST_JSON"),
    keyId: input("AUTHORIZED_KEY_ID"),
    authorization: input("OWNER_AUTHORIZATION"),
  };
}

function expectedAuthorization(a) {
  return `AUTHORIZE LIVE PHASE5 WORKER ACTIVATE rozkalns-control-center source_sha=${a.sha} ci_run=${a.ciRun} preflight_run=${a.preflightRun} deployment=${a.deployment} version=${a.version} candidate_sha256=${a.candidateSha256} key_id=${a.keyId} ingest=true`;
}

function assertInputs(a) {
  if (!SHA1.test(a.sha)) stop("APPROVED_SHA_INVALID", "approved SHA must be 40 lowercase hex characters");
  if (!RUN_ID.test(a.ciRun) || !RUN_ID.test(a.preflightRun)) stop("RUN_ID_INVALID", "CI/preflight run ids must be positive integers");
  if (!UUID.test(a.deployment) || !UUID.test(a.version)) stop("BASELINE_ID_INVALID", "deployment/version ids must be UUIDs");
  if (!SHA256.test(a.candidateSha256)) stop("CANDIDATE_SHA256_INVALID", "candidate digest must be lowercase SHA-256");
  if (!a.candidateRaw) stop("CANDIDATE_MANIFEST_REQUIRED", "exact candidate manifest JSON is required");
  if (!KEY_ID.test(a.keyId)) stop("AUTHORIZED_KEY_ID_INVALID", "key_id format is invalid");
  if (a.authorization !== expectedAuthorization(a)) stop("OWNER_AUTHORIZATION_INVALID", "owner authorization does not exactly bind the execution tuple");
}

function assertExecutionContext(a) {
  const valid =
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_RUN_ATTEMPT === "1" &&
    process.env.GITHUB_REPOSITORY === REPO &&
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    process.env.GITHUB_REF === "refs/heads/main" &&
    process.env.GITHUB_REF_NAME === "main" &&
    process.env.GITHUB_SHA === a.sha &&
    process.env.GITHUB_WORKFLOW_REF === EXPECTED_WORKFLOW_REF &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
    process.env.RUNNER_OS === "Linux";
  if (!valid) {
    stop("EXECUTION_CONTEXT_INVALID", "Worker activation requires the exact default-branch first-attempt GitHub-hosted workflow");
  }
}

function assertCredentials() {
  if (!input("GITHUB_TOKEN")) stop("GITHUB_TOKEN_REQUIRED", "GitHub read token is required");
  if (!input("CLOUDFLARE_WORKERS_READ_TOKEN")) stop("CLOUDFLARE_WORKERS_READ_TOKEN_REQUIRED", "Workers read token is required");
  if (!input("CLOUDFLARE_D1_READ_TOKEN")) stop("CLOUDFLARE_D1_READ_TOKEN_REQUIRED", "D1 read token is required");
  if (!input("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN")) {
    stop("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN_REQUIRED", "dedicated Workers Scripts write token is required");
  }
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
      "User-Agent": "rozkalns-control-phase5-worker-activate-live",
    },
  }, "GITHUB_READ_FAILED");
}

async function cfWorkers(path) {
  const payload = await json(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}${path}`, {
    headers: {
      Authorization: `Bearer ${input("CLOUDFLARE_WORKERS_READ_TOKEN")}`,
      Accept: "application/json",
    },
  }, "CLOUDFLARE_WORKERS_READ_FAILED");
  if (payload?.success !== true) stop("CLOUDFLARE_WORKERS_READ_INVALID", "Workers response was unsuccessful");
  return payload.result;
}

async function cfD1Get(path) {
  const payload = await json(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}${path}`, {
    headers: {
      Authorization: `Bearer ${input("CLOUDFLARE_D1_READ_TOKEN")}`,
      Accept: "application/json",
    },
  }, "CLOUDFLARE_D1_READ_FAILED");
  if (payload?.success !== true) stop("CLOUDFLARE_D1_READ_INVALID", "D1 response was unsuccessful");
  return payload.result;
}

async function cfD1Select(sql) {
  if (!sql.startsWith("SELECT ") || sql.includes(";")) stop("D1_SELECT_INVALID", "D1 evidence query must be one SELECT statement");
  const payload = await json(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input("CLOUDFLARE_D1_READ_TOKEN")}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql }),
    },
    "CLOUDFLARE_D1_SELECT_FAILED",
  );
  const result = payload?.result?.[0];
  if (
    payload?.success !== true ||
    result?.success !== true ||
    !Array.isArray(result?.results) ||
    result?.meta?.changed_db === true ||
    Number(result?.meta?.rows_written ?? 0) !== 0 ||
    Number(result?.meta?.changes ?? 0) !== 0
  ) {
    stop("CLOUDFLARE_D1_SELECT_INVALID", "D1 read evidence reported failure or mutation");
  }
  return result.results;
}

async function assertSource(a, candidate) {
  if (run("git", ["status", "--porcelain"]) !== "") stop("WORKTREE_DIRTY", "activation requires a clean checkout");
  if (run("git", ["rev-parse", "HEAD"]) !== a.sha) stop("HEAD_MISMATCH", "checked-out source differs from approved SHA");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== a.sha) stop("REMOTE_MAIN_MISMATCH", "origin/main moved from approved SHA");

  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (
    pkg?.engines?.node !== NODE_VERSION ||
    pkg?.devEngines?.runtime?.version !== NODE_VERSION ||
    pkg?.devDependencies?.wrangler !== WRANGLER_VERSION
  ) {
    stop("TOOLCHAIN_PIN_INVALID", "Node/Wrangler pins changed");
  }

  const sourceConfigRaw = await readFile("wrangler.jsonc", "utf8");
  if (sha256(sourceConfigRaw) !== candidate.source_config_sha256) {
    stop("SOURCE_CONFIG_SHA256_MISMATCH", "wrangler source config digest differs from candidate");
  }

  const cfg = JSON.parse(sourceConfigRaw);
  if (cfg?.name !== WORKER_NAME || cfg?.vars?.[INGEST_BINDING] !== undefined) {
    stop("SOURCE_CONFIG_BASELINE_INVALID", "source config must target the reviewed Worker and keep ingest dormant");
  }

  const d1 = Array.isArray(cfg?.d1_databases) ? cfg.d1_databases : [];
  if (d1.length !== 1 || d1[0]?.binding !== "CONTROL_DB" || d1[0]?.database_id !== DB_ID) {
    stop("CONTROL_DB_SOURCE_INVALID", "CONTROL_DB source binding changed");
  }

  const installed = run(wrangler(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (installed !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "installed Wrangler differs from reviewed pin");

  const assetDirectory = cfg?.assets?.directory;
  if (typeof assetDirectory !== "string" || !existsSync(resolve(process.cwd(), assetDirectory))) {
    stop("BUILT_ASSETS_MISSING", "exact source assets must be built before authorization can be consumed");
  }

  return cfg;
}

async function assertGitHubEvidence(a, candidate) {
  const main = await gh("/branches/main");
  if (main?.commit?.sha !== a.sha) stop("MAIN_SHA_DRIFT", "current main differs from approved SHA");

  const ci = await gh(`/actions/runs/${a.ciRun}`);
  if (
    ci?.name !== "CI" ||
    ci?.path !== ".github/workflows/ci.yml" ||
    ci?.head_branch !== "main" ||
    ci?.head_sha !== a.sha ||
    ci?.event !== "push" ||
    ci?.status !== "completed" ||
    ci?.conclusion !== "success"
  ) {
    stop("CI_GATE_INVALID", "named CI is not successful exact-main push CI");
  }

  const preflight = await gh(`/actions/runs/${a.preflightRun}`);
  if (
    preflight?.name !== "Phase 5 RPi5 observation GET/SELECT-only preflight" ||
    preflight?.path !== PREFLIGHT_PATH ||
    preflight?.head_branch !== "main" ||
    preflight?.head_sha !== a.sha ||
    preflight?.event !== "workflow_dispatch" ||
    preflight?.status !== "completed" ||
    preflight?.conclusion !== "success" ||
    preflight?.run_attempt !== 1
  ) {
    stop("PREFLIGHT_GATE_INVALID", "named preflight is not successful first-attempt exact-main readonly evidence");
  }

  const provision = await gh(`/actions/runs/${candidate.expected_current.verification_key_prerequisite.provision_run_id}`);
  if (
    provision?.name !== "Phase 5 RPi5 observation verification-key provision" ||
    provision?.path !== PROVISION_PATH ||
    provision?.head_branch !== "main" ||
    provision?.event !== "workflow_dispatch" ||
    provision?.status !== "completed" ||
    provision?.conclusion !== "success" ||
    provision?.run_attempt !== 1
  ) {
    stop("VERIFICATION_KEY_PROVISION_GATE_INVALID", "named verification-key provision run is not successful first-attempt main evidence");
  }

  const provisionSha = provision?.head_sha ?? "";
  const provenance = checkGitAncestor(provisionSha, a.sha, { cwd: process.cwd(), env: cleanEnv() });
  if (!provenance.ok) {
    if (provenance.reason === "INVALID_SHA") {
      stop("VERIFICATION_KEY_PROVISION_SOURCE_INVALID", "provision run source SHA is malformed");
    }
    if (provenance.reason === "NOT_ANCESTOR") {
      stop("VERIFICATION_KEY_PROVISION_SOURCE_NOT_ANCESTOR", "provision run source is not an ancestor of the approved activation source");
    }
    stop("VERIFICATION_KEY_PROVISION_SOURCE_ANCESTRY_CHECK_FAILED", "could not prove verification-key provision source ancestry");
  }
  console.log("VERIFICATION_KEY_PROVISION_SOURCE_ANCESTRY=PASS");

  if (provision?.inputs?.key_id !== undefined && provision.inputs.key_id !== a.keyId) {
    stop("VERIFICATION_KEY_PROVISION_KEY_ID_DRIFT", "provision run public key_id differs from authorization");
  }
}

async function assertD1Ready() {
  const db = await cfD1Get(`/d1/database/${DB_ID}`);
  if (db?.uuid !== DB_ID || db?.name !== DB_NAME || db?.jurisdiction !== DB_JURISDICTION) {
    stop("D1_RESOURCE_IDENTITY_INVALID", "production D1 identity differs from the reviewed Phase 5 target");
  }

  const migrations = await cfD1Select(
    "SELECT id, name FROM d1_migrations WHERE name IN ('0010_webhook_observability_hot_index.sql','0011_rpi5_observation_replay_claims.sql','0012_rpi5_production_visibility_projection.sql','0013_rpi5_observation_atomic_acceptance.sql') ORDER BY id",
  );
  const names = migrations.map((row) => row?.name);
  if (JSON.stringify(names) !== JSON.stringify([
    "0010_webhook_observability_hot_index.sql",
    "0011_rpi5_observation_replay_claims.sql",
    "0012_rpi5_production_visibility_projection.sql",
    "0013_rpi5_observation_atomic_acceptance.sql",
  ])) {
    stop("D1_PHASE5_MIGRATIONS_NOT_PRESENT_VALID", "Phase 5 requires exact migrations 0010 through 0013");
  }

  const schema = await cfD1Select(
    "SELECT type, name, tbl_name FROM sqlite_schema WHERE name IN ('idx_webhook_deliveries_active_updated_delivery','rpi5_observation_replay_claims','rpi5_production_visibility') ORDER BY name",
  );
  const normalized = schema.map((row) => ({
    type: row?.type,
    name: row?.name,
    tbl_name: row?.tbl_name,
  }));
  if (JSON.stringify(normalized) !== JSON.stringify([
    {
      type: "index",
      name: "idx_webhook_deliveries_active_updated_delivery",
      tbl_name: "webhook_deliveries",
    },
    {
      type: "table",
      name: "rpi5_observation_replay_claims",
      tbl_name: "rpi5_observation_replay_claims",
    },
    {
      type: "table",
      name: "rpi5_production_visibility",
      tbl_name: "rpi5_production_visibility",
    },
  ])) {
    stop("D1_PHASE5_SCHEMA_NOT_PRESENT_VALID", "Phase 5 D1 schema/index prerequisites are not exact");
  }

  await cfD1Select("SELECT replay_key, replay_expires_at_ms, claimed_at_ms, claim_token FROM rpi5_observation_replay_claims LIMIT 0");
  await cfD1Select("SELECT project_id, repository, observed_at_ms, stored_at_ms FROM rpi5_production_visibility LIMIT 0");
  console.log("D1_PHASE5_GATE=PRESENT_VALID_0010_THROUGH_0013");
}

function nonTargetBindingsDigest(bindings) {
  const filtered = bindings
    .filter((binding) => binding?.name !== INGEST_BINDING)
    .map(canonical)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return sha256(JSON.stringify(filtered));
}

function assertBindingState(bindings, candidate, expectedIngest) {
  const db = bindings.filter((binding) => binding?.name === "CONTROL_DB");
  if (db.length !== 1 || db[0]?.type !== "d1" || (db[0]?.database_id ?? db[0]?.id ?? "") !== DB_ID) {
    stop("CONTROL_DB_BINDING_DRIFT", "CONTROL_DB binding differs from reviewed prerequisite");
  }

  const key = bindings.filter((binding) => binding?.name === KEY_BINDING);
  if (
    key.length !== 1 ||
    key[0]?.type !== "secret_text" ||
    Object.prototype.hasOwnProperty.call(key[0], "text")
  ) {
    stop("VERIFICATION_KEY_BINDING_DRIFT", "verification key is missing, exposed or not secret_text");
  }

  const ingest = bindings.filter((binding) => binding?.name === INGEST_BINDING);
  if (expectedIngest === "ABSENT" && ingest.length !== 0) {
    stop("INGEST_BASELINE_DRIFT", "ingest was expected absent");
  }
  if (
    expectedIngest === "PRESENT_FALSE" &&
    (ingest.length !== 1 || ingest[0]?.type !== "plain_text" || ingest[0]?.text !== "false")
  ) {
    stop("INGEST_BASELINE_DRIFT", "ingest was expected plain-text false");
  }
  if (
    expectedIngest === "PRESENT_TRUE" &&
    (ingest.length !== 1 || ingest[0]?.type !== "plain_text" || ingest[0]?.text !== "true")
  ) {
    stop("INGEST_CANDIDATE_INVALID", "candidate ingest binding is not exact plain-text true");
  }

  if (nonTargetBindingsDigest(bindings) !== candidate.expected_current.non_target_bindings_sha256) {
    stop("NON_TARGET_BINDING_DIGEST_DRIFT", "non-target binding inventory differs from candidate");
  }
}

async function readWorkerState() {
  const deployments = await cfWorkers(`/workers/scripts/${WORKER_NAME}/deployments`);
  const current = deployments?.deployments?.[0];
  if (
    !current ||
    !Array.isArray(current.versions) ||
    current.versions.length !== 1 ||
    current.versions[0]?.percentage !== 100
  ) {
    stop("WORKER_STATE_INVALID", "Worker must have one active 100-percent version");
  }

  const versionId = current.versions[0]?.version_id;
  if (!UUID.test(current.id ?? "") || !UUID.test(versionId ?? "")) {
    stop("WORKER_STATE_INVALID", "Worker deployment/version identifiers are invalid");
  }

  const version = await cfWorkers(`/workers/scripts/${WORKER_NAME}/versions/${versionId}`);
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  return { deployment: current.id, version: versionId, bindings };
}

async function assertBaseline(a, candidate) {
  const state = await readWorkerState();
  if (state.deployment !== a.deployment || state.version !== a.version) {
    stop("WORKER_BASELINE_DRIFT", "active Worker differs from authorized deployment/version");
  }
  assertBindingState(state.bindings, candidate, candidate.expected_current.ingest_binding_state);
  return state;
}

async function materializeCandidateConfig(sourceConfig) {
  const path = resolve(process.cwd(), ".wrangler.phase5-worker-activate.jsonc");
  if (existsSync(path)) stop("CANDIDATE_CONFIG_PATH_ALREADY_EXISTS", "ephemeral candidate config path is unexpectedly occupied");

  const candidateConfig = structuredClone(sourceConfig);
  candidateConfig.vars = { ...(candidateConfig.vars ?? {}), [INGEST_BINDING]: "true" };

  const sourceComparable = structuredClone(sourceConfig);
  const candidateComparable = structuredClone(candidateConfig);
  delete candidateComparable.vars[INGEST_BINDING];
  if (JSON.stringify(canonical(candidateComparable)) !== JSON.stringify(canonical(sourceComparable))) {
    stop("CANDIDATE_CONFIG_DELTA_INVALID", "materialized config changed more than the reviewed ingest opt-in");
  }

  const raw = `${JSON.stringify(candidateConfig, null, 2)}\n`;
  await writeFile(path, raw, { mode: 0o600 });
  console.log(`CANDIDATE_CONFIG_SHA256=${sha256(raw)}`);
  console.log("SOURCE_CONFIG_DELTA=INGEST_ONLY");
  console.log("TRIGGER_ROUTE_CUSTOM_DOMAIN_QUEUE_MUTATION_PATH=ABSENT");
  return path;
}

function requireRead(path) {
  const result = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))", path],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv(),
    },
  );
  if (result.error || result.status !== 0) throw new Error("read failed");
  return result.stdout;
}

function parseUploadedVersion(outputPath) {
  let raw;
  try {
    raw = requireRead(outputPath);
  } catch {
    stop("VERSION_UPLOAD_OUTPUT_MISSING", "Wrangler upload output file could not be read");
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.type === "version-upload" && UUID.test(item?.version_id ?? "")) {
        return item.version_id;
      }
    } catch {
      // Ignore unrelated non-JSON structured-output lines.
    }
  }
  stop("VERSION_UPLOAD_ID_MISSING", "Wrangler did not report an uploaded version id");
}

function runWranglerWrite(args, outputPath) {
  const result = spawnSync(wrangler(), args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv({
      CLOUDFLARE_API_TOKEN: input("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN"),
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
      WRANGLER_OUTPUT_FILE_PATH: outputPath,
    }),
  });
  if (result.error || result.status !== 0) {
    emitWranglerFailureDiagnostics(outputPath);
    stop("WRANGLER_WRITE_FAILED", `wrangler exited ${result.status ?? "unknown"}`);
  }
}

async function uploadCandidate(a, candidateConfigPath) {
  mutationStarted = true;
  console.log("WORKER_VERSION_UPLOAD_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("MUTATION_CLASS=WORKER_ACTIVATE_ONLY");
  console.log("MUTATION_CEILING=ONE_VERSION_UPLOAD_THEN_EXACT_GET_VERIFIED_VERSION_DEPLOY_100_PERCENT");

  const out = join(tmpdir(), `phase5-worker-upload-${process.env.GITHUB_RUN_ID ?? "run"}.jsonl`);
  runWranglerWrite([
    "versions", "upload",
    "--config", candidateConfigPath,
    "--strict",
    "--message", `Phase5 Worker activate ${a.sha}`,
    "--experimental-provision=false",
    "--experimental-auto-create=false",
  ], out);

  uploadedVersion = parseUploadedVersion(out);
  if (uploadedVersion === a.version) {
    stop("UPLOADED_VERSION_EQUALS_BASELINE", "upload did not create a distinct version");
  }
  console.log(`UPLOADED_VERSION=${uploadedVersion}`);
  return uploadedVersion;
}

async function assertUploadedCandidate(versionId, candidate) {
  const version = await cfWorkers(`/workers/scripts/${WORKER_NAME}/versions/${versionId}`);
  if (version?.id !== versionId) {
    stop("UPLOADED_VERSION_GET_MISMATCH", "GET did not return exact uploaded version");
  }
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  assertBindingState(bindings, candidate, "PRESENT_TRUE");
  console.log("UPLOADED_CANDIDATE_GET_VERIFY=PASS");
}

async function assertPredeployStillSafe(a, candidate) {
  await assertGitHubEvidence(a, candidate);
  await assertD1Ready();
  await assertBaseline(a, candidate);
  console.log("PREDEPLOY_DRIFT_GUARD=PASS");
}

function deployExactCandidate(a, versionId) {
  console.log("EXACT_VERIFIED_VERSION_DEPLOY_STARTED=YES");
  const out = join(tmpdir(), `phase5-worker-deploy-${process.env.GITHUB_RUN_ID ?? "run"}.jsonl`);
  runWranglerWrite([
    "versions", "deploy",
    `${versionId}@100%`,
    "--yes",
    "--message", `Phase5 Worker activate ${a.sha}`,
    "--experimental-provision=false",
    "--experimental-auto-create=false",
  ], out);
}

async function assertPostdeploy(a, candidate, versionId) {
  const main = await gh("/branches/main");
  if (main?.commit?.sha !== a.sha) {
    stop("MAIN_SHA_DRIFT_POSTDEPLOY", "main moved during activation");
  }

  const state = await readWorkerState();
  if (
    state.version !== versionId ||
    state.version === a.version ||
    state.deployment === a.deployment
  ) {
    stop("POSTDEPLOY_EXACT_VERSION_INVALID", "exact uploaded version is not the new active deployment");
  }

  assertBindingState(state.bindings, candidate, "PRESENT_TRUE");
  await assertD1Ready();

  console.log(`RESULT_DEPLOYMENT=${state.deployment}`);
  console.log(`RESULT_VERSION=${state.version}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log("INGEST_BINDING=PLAIN_TEXT_TRUE");
  console.log("VERIFICATION_KEY_BINDING=PRESENT_PROTECTED_UNCHANGED");
  console.log("SECRET_VALUE_OBSERVED=NO");
  console.log("CONTROL_DB_BINDING=UNCHANGED");
  console.log("NON_TARGET_BINDING_INVENTORY=UNCHANGED");
  console.log("TRIGGER_ROUTE_CUSTOM_DOMAIN_QUEUE_MUTATION_PATH=ABSENT");
  console.log("D1_MUTATION=NO");
  console.log("SECRET_MUTATION=NO");
  console.log("RPI5_MUTATION=NO");
  console.log("NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES");
  console.log("PHASE5_WORKER_ACTIVATE=PASS");
}

async function main() {
  const a = inputs();
  assertInputs(a);
  assertExecutionContext(a);
  assertCredentials();

  if (sha256(a.candidateRaw) !== a.candidateSha256) {
    stop("CANDIDATE_SHA256_MISMATCH", "exact manifest bytes do not match authorized candidate digest");
  }

  const candidate = parseCandidate(a.candidateRaw);
  if (
    candidate.source_sha !== a.sha ||
    candidate.ci_run_id !== a.ciRun ||
    candidate.preflight_run_id !== a.preflightRun ||
    candidate.expected_current.deployment_id !== a.deployment ||
    candidate.expected_current.version_id !== a.version ||
    candidate.expected_current.verification_key_prerequisite.key_id !== a.keyId
  ) {
    stop("CANDIDATE_AUTHORIZATION_TUPLE_MISMATCH", "candidate identity differs from owner-authorized public tuple");
  }

  console.log(`CANDIDATE_MANIFEST=VALID sha256=${a.candidateSha256} key_id=${a.keyId}`);

  const sourceConfig = await assertSource(a, candidate);
  await assertGitHubEvidence(a, candidate);
  await assertD1Ready();
  await assertBaseline(a, candidate);
  const candidateConfigPath = await materializeCandidateConfig(sourceConfig);

  // Final prewrite barrier. No production mutation has occurred before this point.
  await assertGitHubEvidence(a, candidate);
  await assertD1Ready();
  await assertBaseline(a, candidate);

  const versionId = await uploadCandidate(a, candidateConfigPath);
  await assertUploadedCandidate(versionId, candidate);
  await assertPredeployStillSafe(a, candidate);
  deployExactCandidate(a, versionId);
  await assertPostdeploy(a, candidate, versionId);
}

main().catch((error) => {
  if (!process.exitCode) {
    console.error("STOP=UNEXPECTED_EXECUTOR_ERROR");
    if (mutationStarted) {
      console.error("POST_MUTATION_STATE=REVIEW_REQUIRED");
      console.error("AUTHORIZATION_CONSUMED=YES");
      console.error("NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES");
    }
    process.exitCode = 1;
  }
  if (error?.name !== "Error" || !/^([A-Z0-9_]+)$/.test(error?.message ?? "")) {
    console.error("UNEXPECTED_ERROR_REDACTED=YES");
  }
});
