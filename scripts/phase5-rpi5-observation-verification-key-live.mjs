#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO = "rozkalnsandris/rozkalns-control-center";
const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-verification-key-live.yml";
const PREFLIGHT_PATH = ".github/workflows/phase5-rpi5-observation-readonly-preflight.yml";
const EXPECTED_WORKFLOW_REF = `${REPO}/${WORKFLOW_PATH}@refs/heads/main`;
const CF_ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
const WORKER_NAME = "rozkalns-control";
const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
const BINDING = "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS";
const REGISTRY_VERSION = "control-phase5-rpi5-verification-keys-v1";
const WRANGLER_VERSION = "4.120.0";
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
let mutationStarted = false;

function stop(code, message) {
  if (mutationStarted) console.error("POST_MUTATION_STATE=REVIEW_REQUIRED");
  console.error(`STOP=${code}`);
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
  throw new Error(code);
}

function input(name) {
  return process.env[name] ?? "";
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
    "CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN",
    "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE",
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
  if (result.error || result.status !== 0) stop("COMMAND_FAILED", `${command} exited ${result.status ?? "unknown"}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function expectedAuthorization(a) {
  return `AUTHORIZE LIVE PHASE5 VERIFICATION KEY PROVISION rozkalns-control-center source_sha=${a.sha} ci_run=${a.ciRun} preflight_run=${a.preflightRun} deployment=${a.deployment} version=${a.version} binding=${BINDING} key_id=${a.keyId}`;
}

function inputs() {
  return {
    sha: input("APPROVED_SHA"),
    ciRun: input("EXPECTED_CI_RUN"),
    preflightRun: input("EXPECTED_PREFLIGHT_RUN"),
    deployment: input("EXPECTED_DEPLOYMENT"),
    version: input("EXPECTED_VERSION"),
    keyId: input("AUTHORIZED_KEY_ID"),
    binding: input("EXPECTED_BINDING"),
    authorization: input("OWNER_AUTHORIZATION"),
  };
}

function assertInputs(a) {
  if (!/^[0-9a-f]{40}$/.test(a.sha)) stop("APPROVED_SHA_INVALID", "approved SHA must be 40 lowercase hex characters");
  if (!/^[1-9][0-9]*$/.test(a.ciRun)) stop("EXPECTED_CI_RUN_INVALID", "CI run id must be positive");
  if (!/^[1-9][0-9]*$/.test(a.preflightRun)) stop("EXPECTED_PREFLIGHT_RUN_INVALID", "preflight run id must be positive");
  if (!/^[0-9a-f-]{36}$/.test(a.deployment)) stop("EXPECTED_DEPLOYMENT_INVALID", "deployment id must be a UUID");
  if (!/^[0-9a-f-]{36}$/.test(a.version)) stop("EXPECTED_VERSION_INVALID", "version id must be a UUID");
  if (!KEY_ID_PATTERN.test(a.keyId)) stop("AUTHORIZED_KEY_ID_INVALID", "key_id does not match the reviewed public identifier format");
  if (a.binding !== BINDING) stop("EXPECTED_BINDING_INVALID", "only the reviewed verification-key binding may be provisioned");
  if (a.authorization !== expectedAuthorization(a)) stop("OWNER_AUTHORIZATION_INVALID", "owner authorization does not exactly bind the execution inputs");
}

function assertExecutionContext(a) {
  if (process.env.GITHUB_ACTIONS !== "true") stop("GITHUB_ACTIONS_REQUIRED", "verification-key provision is GitHub-hosted only");
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
  if (!valid) stop("EXECUTION_CONTEXT_INVALID", "provision requires the exact default-branch workflow on a GitHub-hosted Linux runner");
}

function assertCredentialsPresent() {
  if (!input("GITHUB_TOKEN")) stop("GITHUB_TOKEN_REQUIRED", "GitHub read token is required");
  if (!input("CLOUDFLARE_WORKERS_READ_TOKEN")) stop("CLOUDFLARE_WORKERS_READ_TOKEN_REQUIRED", "Workers read token is required");
  if (!input("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN")) stop("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN_REQUIRED", "dedicated Workers Scripts write token is required");
  if (!input("CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE")) stop("VERIFICATION_KEY_REGISTRY_SECRET_REQUIRED", "protected registry secret is required");
}

function assertRepo(a) {
  if (run("git", ["status", "--porcelain"]) !== "") stop("WORKTREE_DIRTY", "provision requires a clean checkout");
  if (run("git", ["rev-parse", "HEAD"]) !== a.sha) stop("HEAD_MISMATCH", "checked-out source differs from approved SHA");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== a.sha) stop("REMOTE_MAIN_MISMATCH", "origin/main moved from approved SHA");
}

async function assertSource() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.engines?.node !== "24.19.0" || pkg?.devEngines?.runtime?.version !== "24.19.0") stop("NODE_PIN_INVALID", "canonical Node pin changed");
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) stop("WRANGLER_PIN_INVALID", "Wrangler pin changed");
  const cfg = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  if (cfg?.name !== WORKER_NAME) stop("WORKER_TARGET_INVALID", "Wrangler target Worker changed");
  const d1 = Array.isArray(cfg?.d1_databases) ? cfg.d1_databases : [];
  if (d1.length !== 1 || d1[0]?.binding !== "CONTROL_DB" || d1[0]?.database_id !== DB_ID) stop("CONTROL_DB_SOURCE_INVALID", "production CONTROL_DB source binding changed");
  const version = run(wrangler(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "installed Wrangler does not match the reviewed pin");
}

function exactObjectKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function assertRegistry(a) {
  let registry;
  try {
    registry = JSON.parse(input("CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE"));
  } catch {
    stop("VERIFICATION_KEY_REGISTRY_INVALID", "protected registry secret is not valid JSON");
  }
  if (!exactObjectKeys(registry, ["version", "keys"]) || registry.version !== REGISTRY_VERSION || !Array.isArray(registry.keys) || registry.keys.length !== 1) {
    stop("VERIFICATION_KEY_REGISTRY_INVALID", "registry must have the exact v1 shape with exactly one key");
  }
  const entry = registry.keys[0];
  if (!exactObjectKeys(entry, ["keyId", "publicKeyBase64url"]) || entry.keyId !== a.keyId || !KEY_ID_PATTERN.test(entry.keyId)) {
    stop("VERIFICATION_KEY_REGISTRY_KEY_ID_INVALID", "registry key does not exactly match authorized key_id");
  }
  if (!PUBLIC_KEY_PATTERN.test(entry.publicKeyBase64url)) stop("VERIFICATION_KEY_REGISTRY_PUBLIC_KEY_INVALID", "public key is not canonical raw Ed25519 base64url");
  let decoded;
  try {
    decoded = Buffer.from(entry.publicKeyBase64url, "base64url");
  } catch {
    stop("VERIFICATION_KEY_REGISTRY_PUBLIC_KEY_INVALID", "public key decoding failed");
  }
  if (decoded.length !== 32 || decoded.toString("base64url") !== entry.publicKeyBase64url) stop("VERIFICATION_KEY_REGISTRY_PUBLIC_KEY_INVALID", "public key must encode exactly 32 Ed25519 bytes canonically");
  console.log(`VERIFICATION_KEY_REGISTRY=VALID key_id=${a.keyId} key_count=1`);
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
      "User-Agent": "rozkalns-control-phase5-verification-key-live",
    },
  }, "GITHUB_READ_FAILED");
}

async function cf(path) {
  const payload = await json(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}${path}`, {
    headers: {
      Authorization: `Bearer ${input("CLOUDFLARE_WORKERS_READ_TOKEN")}`,
      Accept: "application/json",
    },
  }, "CLOUDFLARE_READ_FAILED");
  if (payload?.success !== true) stop("CLOUDFLARE_READ_INVALID", "Cloudflare response was unsuccessful");
  return payload.result;
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function bindingSnapshot(bindings) {
  return JSON.stringify(bindings.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function assertRequiredBaselineBindings(bindings) {
  const db = bindings.filter((binding) => binding?.name === "CONTROL_DB");
  if (db.length !== 1 || db[0]?.type !== "d1" || (db[0]?.database_id ?? db[0]?.id ?? "") !== DB_ID) stop("CONTROL_DB_BINDING_DRIFT", "Worker CONTROL_DB binding changed");
  if (bindings.some((binding) => binding?.name === "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED")) stop("INGEST_BASELINE_DRIFT", "verification-key provision requires ingest to remain dormant");
  if (bindings.some((binding) => binding?.name === BINDING)) stop("VERIFICATION_KEY_BASELINE_DRIFT", "verification-key binding must be absent before the one-shot provision");
}

async function readWorkerState() {
  const deployments = await cf(`/workers/scripts/${WORKER_NAME}/deployments`);
  const current = deployments?.deployments?.[0];
  if (!current || !Array.isArray(current.versions) || current.versions.length !== 1 || current.versions[0]?.percentage !== 100) stop("WORKER_STATE_INVALID", "Worker must have one active 100-percent version");
  const versionId = current.versions[0]?.version_id;
  if (typeof current.id !== "string" || typeof versionId !== "string") stop("WORKER_STATE_INVALID", "Worker deployment/version identifiers are missing");
  const version = await cf(`/workers/scripts/${WORKER_NAME}/versions/${versionId}`);
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  return { deployment: current.id, version: versionId, bindings };
}

async function assertWorkerBaseline(a) {
  const state = await readWorkerState();
  if (state.deployment !== a.deployment || state.version !== a.version) stop("WORKER_BASELINE_DRIFT", "active deployment/version differs from the authorized preflight baseline");
  assertRequiredBaselineBindings(state.bindings);
  return state;
}

function provisionSecret() {
  mutationStarted = true;
  console.log("SECRET_PROVISION_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("MUTATION_CEILING=CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_ONLY");
  const result = spawnSync(wrangler(), ["secret", "put", BINDING, "--name", WORKER_NAME], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: input("CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_PROVISION_VALUE"),
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv({
      CLOUDFLARE_API_TOKEN: input("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN"),
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
    }),
  });
  if (result.error || result.status !== 0) stop("SECRET_PROVISION_FAILED", `wrangler secret put exited ${result.status ?? "unknown"}`);
  console.log("SECRET_PROVISION_COMMAND=PASS");
}

async function assertPostwrite(a, baseline) {
  const state = await readWorkerState();
  if (state.deployment === baseline.deployment || state.version === baseline.version) stop("POSTWRITE_VERSION_NOT_NEW", "secret provision did not produce a new active deployment/version");
  const target = state.bindings.filter((binding) => binding?.name === BINDING);
  if (target.length !== 1 || target[0]?.type !== "secret_text" || Object.prototype.hasOwnProperty.call(target[0], "text")) {
    stop("POSTWRITE_SECRET_BINDING_INVALID", "postwrite evidence must expose only the protected secret binding metadata");
  }
  if (state.bindings.some((binding) => binding?.name === "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED")) stop("POSTWRITE_INGEST_ACTIVATED", "verification-key provision must not activate ingest");
  const remaining = state.bindings.filter((binding) => binding?.name !== BINDING);
  if (bindingSnapshot(remaining) !== bindingSnapshot(baseline.bindings)) stop("POSTWRITE_BINDING_DRIFT", "non-secret Worker binding inventory changed");
  const db = remaining.filter((binding) => binding?.name === "CONTROL_DB");
  if (db.length !== 1 || (db[0]?.database_id ?? db[0]?.id ?? "") !== DB_ID) stop("POSTWRITE_CONTROL_DB_DRIFT", "CONTROL_DB changed during secret provision");
  console.log(`RESULTING_DEPLOYMENT=${state.deployment}`);
  console.log(`RESULTING_VERSION=${state.version}`);
  console.log(`PROTECTED_BINDING=${BINDING}:secret_text`);
  console.log(`AUTHORIZED_KEY_ID=${a.keyId}`);
  console.log("SECRET_VALUE_OBSERVED=NO");
  console.log("NON_SECRET_BINDING_INVENTORY=UNCHANGED");
  console.log("INGEST_ACTIVATION=NO");
  console.log("D1_MUTATION=NO");
  console.log("QUEUE_MUTATION=NO");
  console.log("ROUTE_DNS_ACCESS_RPI5_MUTATION=NO");
  console.log("NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES");
  console.log("PHASE5_VERIFICATION_KEY_PROVISION=PASS");
}

async function main() {
  const a = inputs();
  assertInputs(a);
  assertExecutionContext(a);
  assertCredentialsPresent();
  assertRepo(a);
  await assertSource();
  assertRegistry(a);
  await assertGitHubEvidence(a);
  const baseline = await assertWorkerBaseline(a);

  // Re-read every mutable gate immediately before the first and only authorized mutation.
  assertRepo(a);
  await assertGitHubEvidence(a);
  const freshBaseline = await assertWorkerBaseline(a);
  if (freshBaseline.deployment !== baseline.deployment || freshBaseline.version !== baseline.version || bindingSnapshot(freshBaseline.bindings) !== bindingSnapshot(baseline.bindings)) {
    stop("PREWRITE_BASELINE_DRIFT", "Worker state changed during prewrite validation");
  }

  provisionSecret();
  await assertPostwrite(a, baseline);
}

main().catch((error) => {
  if (!process.exitCode) {
    console.error("STOP=UNEXPECTED_EXECUTOR_ERROR");
    console.error(error instanceof Error ? error.message : "unexpected executor failure");
    process.exitCode = 1;
  }
});
