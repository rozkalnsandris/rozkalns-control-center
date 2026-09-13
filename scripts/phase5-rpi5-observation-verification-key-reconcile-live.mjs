#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO = "rozkalnsandris/rozkalns-control-center";
const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-verification-key-reconcile-live.yml";
const POST_ACTIVATION_VERIFY_PATH = ".github/workflows/phase5-rpi5-observation-worker-post-activation-verify.yml";
const POST_ACTIVATION_VERIFY_NAME = "Phase 5 RPi5 observation Worker post-activation GET-only verify";
const EXPECTED_WORKFLOW_REF = `${REPO}/${WORKFLOW_PATH}@refs/heads/main`;
const CF_ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
const WORKER_NAME = "rozkalns-control";
const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
const INGEST_BINDING = "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED";
const BINDING = "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS";
const REGISTRY_VERSION = "control-phase5-rpi5-verification-keys-v1";
const WRANGLER_VERSION = "4.120.0";
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
    "AUTHORIZED_PUBLIC_KEY_BASE64URL",
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
  if (result.error || result.status !== 0) stop("COMMAND_FAILED", `${command} exited ${result.status ?? "unknown"}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function inputs() {
  return {
    sha: input("APPROVED_SHA"),
    ciRun: input("EXPECTED_CI_RUN"),
    postActivationVerifyRun: input("EXPECTED_POST_ACTIVATION_VERIFY_RUN"),
    deployment: input("EXPECTED_DEPLOYMENT"),
    version: input("EXPECTED_VERSION"),
    keyId: input("AUTHORIZED_KEY_ID"),
    publicKeyBase64url: input("AUTHORIZED_PUBLIC_KEY_BASE64URL"),
    binding: input("EXPECTED_BINDING"),
    authorization: input("OWNER_AUTHORIZATION"),
  };
}

function validatePublicKey(value) {
  if (!PUBLIC_KEY_PATTERN.test(value)) stop("AUTHORIZED_PUBLIC_KEY_INVALID", "public key is not canonical raw Ed25519 base64url");
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    stop("AUTHORIZED_PUBLIC_KEY_INVALID", "public key decoding failed");
  }
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    stop("AUTHORIZED_PUBLIC_KEY_INVALID", "public key must encode exactly 32 Ed25519 bytes canonically");
  }
  return createHash("sha256").update(decoded).digest("hex");
}

function expectedAuthorization(a, publicKeySha256) {
  return `AUTHORIZE LIVE PHASE5 VERIFICATION KEY RECONCILE rozkalns-control-center source_sha=${a.sha} ci_run=${a.ciRun} post_activation_verify_run=${a.postActivationVerifyRun} deployment=${a.deployment} version=${a.version} binding=${BINDING} key_id=${a.keyId} public_key_sha256=${publicKeySha256}`;
}

function assertInputs(a) {
  if (!SHA1.test(a.sha)) stop("APPROVED_SHA_INVALID", "approved SHA must be 40 lowercase hex characters");
  if (!RUN_ID.test(a.ciRun)) stop("EXPECTED_CI_RUN_INVALID", "CI run id must be positive");
  if (!RUN_ID.test(a.postActivationVerifyRun)) stop("EXPECTED_POST_ACTIVATION_VERIFY_RUN_INVALID", "post-activation verify run id must be positive");
  if (!UUID.test(a.deployment)) stop("EXPECTED_DEPLOYMENT_INVALID", "deployment id must be a UUID");
  if (!UUID.test(a.version)) stop("EXPECTED_VERSION_INVALID", "version id must be a UUID");
  if (!KEY_ID_PATTERN.test(a.keyId)) stop("AUTHORIZED_KEY_ID_INVALID", "key_id does not match the reviewed public identifier format");
  if (a.binding !== BINDING) stop("EXPECTED_BINDING_INVALID", "only the reviewed verification-key binding may be reconciled");
  const publicKeySha256 = validatePublicKey(a.publicKeyBase64url);
  if (a.authorization !== expectedAuthorization(a, publicKeySha256)) {
    stop("OWNER_AUTHORIZATION_INVALID", "owner authorization does not exactly bind the execution inputs");
  }
  return publicKeySha256;
}

function assertExecutionContext(a) {
  if (process.env.GITHUB_ACTIONS !== "true") stop("GITHUB_ACTIONS_REQUIRED", "verification-key reconcile is GitHub-hosted only");
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
  if (!valid) stop("EXECUTION_CONTEXT_INVALID", "reconcile requires the exact default-branch workflow on a GitHub-hosted Linux runner");
}

function assertCredentialsPresent() {
  if (!input("GITHUB_TOKEN")) stop("GITHUB_TOKEN_REQUIRED", "GitHub read token is required");
  if (!input("CLOUDFLARE_WORKERS_READ_TOKEN")) stop("CLOUDFLARE_WORKERS_READ_TOKEN_REQUIRED", "Workers read token is required");
  if (!input("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN")) stop("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN_REQUIRED", "dedicated Workers Scripts write token is required");
}

function assertRepo(a) {
  if (run("git", ["status", "--porcelain"]) !== "") stop("WORKTREE_DIRTY", "reconcile requires a clean checkout");
  if (run("git", ["rev-parse", "HEAD"]) !== a.sha) stop("HEAD_MISMATCH", "checked-out source differs from approved SHA");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== a.sha) stop("REMOTE_MAIN_MISMATCH", "origin/main moved from approved SHA");
}

async function sourceConfig() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.engines?.node !== "24.19.0" || pkg?.devEngines?.runtime?.version !== "24.19.0") stop("NODE_PIN_INVALID", "canonical Node pin changed");
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) stop("WRANGLER_PIN_INVALID", "Wrangler pin changed");
  const cfg = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  if (cfg?.name !== WORKER_NAME) stop("WORKER_TARGET_INVALID", "Wrangler target Worker changed");
  const d1 = Array.isArray(cfg?.d1_databases) ? cfg.d1_databases : [];
  if (d1.length !== 1 || d1[0]?.binding !== "CONTROL_DB" || d1[0]?.database_id !== DB_ID) stop("CONTROL_DB_SOURCE_INVALID", "production CONTROL_DB source binding changed");
  const version = run(wrangler(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "installed Wrangler does not match the reviewed pin");
  return cfg;
}

function buildRegistry(a) {
  return JSON.stringify({
    version: REGISTRY_VERSION,
    keys: [{ keyId: a.keyId, publicKeyBase64url: a.publicKeyBase64url }],
  });
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
      "User-Agent": "rozkalns-control-phase5-verification-key-reconcile-live",
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
  if (
    ci?.name !== "CI" ||
    ci?.path !== ".github/workflows/ci.yml" ||
    ci?.head_branch !== "main" ||
    ci?.head_sha !== a.sha ||
    ci?.event !== "push" ||
    ci?.status !== "completed" ||
    ci?.conclusion !== "success"
  ) stop("CI_GATE_INVALID", "named CI run is not successful exact-main push CI");

  const verify = await gh(`/actions/runs/${a.postActivationVerifyRun}`);
  if (
    verify?.name !== POST_ACTIVATION_VERIFY_NAME ||
    verify?.path !== POST_ACTIVATION_VERIFY_PATH ||
    verify?.head_branch !== "main" ||
    verify?.head_sha !== a.sha ||
    verify?.event !== "workflow_dispatch" ||
    verify?.status !== "completed" ||
    verify?.conclusion !== "success" ||
    verify?.run_attempt !== 1
  ) stop("POST_ACTIVATION_VERIFY_GATE_INVALID", "named verifier is not a successful first-attempt exact-main post-activation GET-only run");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function bindingSnapshot(bindings) {
  return JSON.stringify(bindings.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function withoutTarget(bindings) {
  return bindings.filter((binding) => binding?.name !== BINDING);
}

function assertRequiredPostActivationBindings(bindings) {
  const db = bindings.filter((binding) => binding?.name === "CONTROL_DB");
  if (db.length !== 1 || db[0]?.type !== "d1" || (db[0]?.database_id ?? db[0]?.id ?? "") !== DB_ID) {
    stop("CONTROL_DB_BINDING_DRIFT", "Worker CONTROL_DB binding changed");
  }

  const ingest = bindings.filter((binding) => binding?.name === INGEST_BINDING);
  if (ingest.length !== 1 || ingest[0]?.type !== "plain_text" || ingest[0]?.text !== "true") {
    stop("INGEST_BASELINE_DRIFT", "post-activation reconcile requires ingest to remain exact plain-text true");
  }

  const target = bindings.filter((binding) => binding?.name === BINDING);
  if (
    target.length !== 1 ||
    target[0]?.type !== "secret_text" ||
    Object.prototype.hasOwnProperty.call(target[0], "text") ||
    Object.prototype.hasOwnProperty.call(target[0], "value")
  ) stop("VERIFICATION_KEY_BASELINE_DRIFT", "verification-key binding must already be present as protected secret_text with value unobserved");
}

async function runtimeSnapshot(versionResource) {
  const cfg = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const runtime = versionResource?.resources?.script_runtime;
  if (!runtime || runtime.compatibility_date !== cfg.compatibility_date) {
    stop("COMPATIBILITY_DATE_DRIFT", "active Worker compatibility date differs from current source");
  }
  const expectedFlags = Array.isArray(cfg.compatibility_flags) ? [...cfg.compatibility_flags].sort() : [];
  const observedFlags = Array.isArray(runtime.compatibility_flags) ? [...runtime.compatibility_flags].sort() : [];
  if (JSON.stringify(observedFlags) !== JSON.stringify(expectedFlags)) {
    stop("COMPATIBILITY_FLAGS_DRIFT", "active Worker compatibility flags differ from current source");
  }
  const scriptEtag = versionResource?.resources?.script?.etag;
  if (typeof scriptEtag !== "string" || scriptEtag.length === 0) stop("SCRIPT_IDENTITY_MISSING", "active Worker version lacks script identity metadata");
  return JSON.stringify({ compatibilityDate: runtime.compatibility_date, compatibilityFlags: observedFlags });
}

async function readWorkerState() {
  const deployments = await cf(`/workers/scripts/${WORKER_NAME}/deployments`);
  const current = deployments?.deployments?.[0];
  if (!current || !Array.isArray(current.versions) || current.versions.length !== 1 || current.versions[0]?.percentage !== 100) {
    stop("WORKER_STATE_INVALID", "Worker must have one active 100-percent version");
  }
  const versionId = current.versions[0]?.version_id;
  if (typeof current.id !== "string" || typeof versionId !== "string") stop("WORKER_STATE_INVALID", "Worker deployment/version identifiers are missing");
  const versionResource = await cf(`/workers/scripts/${WORKER_NAME}/versions/${versionId}`);
  if (versionResource?.id !== versionId) stop("VERSION_ID_DRIFT", "version detail does not match the active version");
  const bindings = Array.isArray(versionResource?.resources?.bindings) ? versionResource.resources.bindings : [];
  return { deployment: current.id, version: versionId, bindings, versionResource };
}

async function assertWorkerBaseline(a) {
  const state = await readWorkerState();
  if (state.deployment !== a.deployment || state.version !== a.version) stop("WORKER_BASELINE_DRIFT", "active deployment/version differs from the authorized post-activation verifier baseline");
  assertRequiredPostActivationBindings(state.bindings);
  const runtime = await runtimeSnapshot(state.versionResource);
  return { ...state, runtime };
}

function reconcileSecret(a, publicKeySha256) {
  const registry = buildRegistry(a);
  mutationStarted = true;
  console.log("SECRET_RECONCILE_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("MUTATION_CEILING=CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS_ONLY");
  console.log(`AUTHORIZED_KEY_ID=${a.keyId}`);
  console.log(`AUTHORIZED_PUBLIC_KEY_SHA256=${publicKeySha256}`);
  const result = spawnSync(wrangler(), ["secret", "put", BINDING, "--name", WORKER_NAME], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: registry,
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv({
      CLOUDFLARE_API_TOKEN: input("CLOUDFLARE_WORKERS_SCRIPTS_WRITE_TOKEN"),
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
    }),
  });
  if (result.error || result.status !== 0) stop("SECRET_RECONCILE_FAILED", `wrangler secret put exited ${result.status ?? "unknown"}`);
  console.log("SECRET_RECONCILE_COMMAND=PASS");
}

async function assertPostwrite(a, baseline, publicKeySha256) {
  const state = await readWorkerState();
  if (state.deployment === baseline.deployment || state.version === baseline.version) {
    stop("POSTWRITE_VERSION_NOT_NEW", "secret reconcile did not produce a new active deployment/version");
  }
  assertRequiredPostActivationBindings(state.bindings);
  if (bindingSnapshot(withoutTarget(state.bindings)) !== bindingSnapshot(withoutTarget(baseline.bindings))) {
    stop("POSTWRITE_BINDING_DRIFT", "non-target Worker binding inventory changed");
  }
  const runtime = await runtimeSnapshot(state.versionResource);
  if (runtime !== baseline.runtime) stop("POSTWRITE_RUNTIME_DRIFT", "Worker runtime configuration changed during secret reconcile");

  console.log(`RESULTING_DEPLOYMENT=${state.deployment}`);
  console.log(`RESULTING_VERSION=${state.version}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log("INGEST_BINDING=PLAIN_TEXT_TRUE_UNCHANGED");
  console.log(`PROTECTED_BINDING=${BINDING}:secret_text`);
  console.log(`AUTHORIZED_KEY_ID=${a.keyId}`);
  console.log(`AUTHORIZED_PUBLIC_KEY_SHA256=${publicKeySha256}`);
  console.log("SECRET_VALUE_OBSERVED=NO");
  console.log("NON_TARGET_BINDING_INVENTORY=UNCHANGED");
  console.log("CONTROL_DB_BINDING=VALID_UNCHANGED");
  console.log("SCRIPT_RUNTIME_CONFIG=EXPECTED_UNCHANGED");
  console.log("D1_MUTATION=NO");
  console.log("QUEUE_MUTATION=NO");
  console.log("ROUTE_DNS_ACCESS_RPI5_MUTATION=NO");
  console.log("NO_RETRY_ROLLBACK_CLEANUP_OR_ALTERNATE_MUTATION=YES");
  console.log("PHASE5_VERIFICATION_KEY_RECONCILE=PASS");
}

async function main() {
  const a = inputs();
  const publicKeySha256 = assertInputs(a);
  assertExecutionContext(a);
  assertCredentialsPresent();
  assertRepo(a);
  await sourceConfig();
  await assertGitHubEvidence(a);
  const baseline = await assertWorkerBaseline(a);

  // Re-read every mutable gate immediately before the first and only authorized mutation.
  assertRepo(a);
  await assertGitHubEvidence(a);
  const freshBaseline = await assertWorkerBaseline(a);
  if (
    freshBaseline.deployment !== baseline.deployment ||
    freshBaseline.version !== baseline.version ||
    bindingSnapshot(freshBaseline.bindings) !== bindingSnapshot(baseline.bindings) ||
    freshBaseline.runtime !== baseline.runtime
  ) stop("PREWRITE_BASELINE_DRIFT", "Worker state changed during prewrite validation");

  reconcileSecret(a, publicKeySha256);
  await assertPostwrite(a, baseline, publicKeySha256);
}

main().catch((error) => {
  if (!process.exitCode) {
    if (mutationStarted) console.error("POST_MUTATION_STATE=REVIEW_REQUIRED");
    console.error("STOP=UNEXPECTED_EXECUTOR_ERROR");
    console.error(error instanceof Error ? error.message : "unexpected executor failure");
    process.exitCode = 1;
  }
});
