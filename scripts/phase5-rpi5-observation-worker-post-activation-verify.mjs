#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const REPO = "rozkalnsandris/rozkalns-control-center";
const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-worker-post-activation-verify.yml";
const EXPECTED_WORKFLOW_REF = `${REPO}/${WORKFLOW_PATH}@refs/heads/main`;
const CF_ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
const WORKER_NAME = "rozkalns-control";
const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
const INGEST_BINDING = "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED";
const KEY_BINDING = "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS";

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function input(name) {
  return process.env[name] ?? "";
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function emitZeroMutationMarkers(stream = console.log) {
  stream("WORKER_MUTATION=NO");
  stream("WORKER_UPLOAD=NO");
  stream("WORKER_DEPLOY=NO");
  stream("WORKER_CONFIG_MUTATION=NO");
  stream("D1_MUTATION=NO");
  stream("QUEUE_MUTATION=NO");
  stream("SECRET_VALUE_OBSERVED=NO");
  stream("SECRET_MUTATION=NO");
  stream("CLOUDFLARE_SETTINGS_MUTATION=NO");
  stream("RPI5_REQUEST=NO");
  stream("LIVE_AUTHORIZATION=NOT_GRANTED");
}

function stop(code, message) {
  console.error("PHASE5_WORKER_POST_ACTIVATION_VERIFY=STOP");
  console.error(`STOP=${code}`);
  emitZeroMutationMarkers(console.error);
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
  throw new Error(code);
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
      "User-Agent": "rozkalns-control-phase5-worker-post-activation-verify",
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

function inputs() {
  return {
    sha: input("APPROVED_SHA"),
    ciRun: input("EXPECTED_CI_RUN"),
    deployment: input("EXPECTED_DEPLOYMENT"),
    version: input("EXPECTED_VERSION"),
    nonTargetBindingsSha256: input("EXPECTED_NON_TARGET_BINDINGS_SHA256"),
  };
}

function assertInputs(a) {
  if (!SHA1.test(a.sha)) stop("APPROVED_SHA_INVALID", "approved SHA must be 40 lowercase hex characters");
  if (!RUN_ID.test(a.ciRun)) stop("CI_RUN_ID_INVALID", "CI run id must be a positive integer");
  if (!UUID.test(a.deployment) || !UUID.test(a.version)) {
    stop("WORKER_IDENTITY_INVALID", "expected deployment/version identifiers must be UUIDs");
  }
  if (!SHA256.test(a.nonTargetBindingsSha256)) {
    stop("NON_TARGET_BINDING_DIGEST_INVALID", "expected non-target binding digest must be lowercase SHA-256");
  }
}

function assertExecutionContext(a) {
  const valid =
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_REPOSITORY === REPO &&
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    process.env.GITHUB_REF === "refs/heads/main" &&
    process.env.GITHUB_REF_NAME === "main" &&
    process.env.GITHUB_SHA === a.sha &&
    process.env.GITHUB_WORKFLOW_REF === EXPECTED_WORKFLOW_REF &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
    process.env.RUNNER_OS === "Linux";
  if (!valid) stop("EXECUTION_CONTEXT_INVALID", "verification requires the exact default-branch GitHub-hosted workflow");
}

function assertCredentials() {
  if (!input("GITHUB_TOKEN")) stop("GITHUB_TOKEN_REQUIRED", "GitHub read token is required");
  if (!input("CLOUDFLARE_WORKERS_READ_TOKEN")) {
    stop("CLOUDFLARE_WORKERS_READ_TOKEN_REQUIRED", "Workers Scripts read token is required");
  }
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
  ) {
    stop("CI_GATE_INVALID", "named CI is not successful exact-main push CI");
  }
}

function nonTargetBindingsDigest(bindings) {
  const filtered = bindings
    .filter((binding) => binding?.name !== INGEST_BINDING)
    .map(canonical)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return sha256(JSON.stringify(filtered));
}

function assertBindings(bindings, expectedDigest) {
  const db = bindings.filter((binding) => binding?.name === "CONTROL_DB");
  if (db.length !== 1 || db[0]?.type !== "d1" || (db[0]?.database_id ?? db[0]?.id ?? "") !== DB_ID) {
    stop("CONTROL_DB_BINDING_DRIFT", "CONTROL_DB binding identity differs from the reviewed production resource");
  }

  const key = bindings.filter((binding) => binding?.name === KEY_BINDING);
  if (
    key.length !== 1 ||
    key[0]?.type !== "secret_text" ||
    Object.prototype.hasOwnProperty.call(key[0], "text") ||
    Object.prototype.hasOwnProperty.call(key[0], "value")
  ) {
    stop("VERIFICATION_KEY_BINDING_INVALID", "verification-key binding is missing, exposed, or not protected secret_text");
  }

  const ingest = bindings.filter((binding) => binding?.name === INGEST_BINDING);
  if (
    ingest.length !== 1 ||
    ingest[0]?.type !== "plain_text" ||
    ingest[0]?.text !== "true"
  ) {
    stop("INGEST_BINDING_NOT_ACTIVE", "post-activation ingest binding must be exact plain-text true");
  }

  const observedDigest = nonTargetBindingsDigest(bindings);
  if (observedDigest !== expectedDigest) {
    stop("NON_TARGET_BINDING_DIGEST_DRIFT", "non-target Worker binding inventory differs from the reviewed activation candidate");
  }
  return observedDigest;
}

async function assertRuntimeConfig(version) {
  const sourceConfig = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const runtime = version?.resources?.script_runtime;
  if (!runtime || runtime.compatibility_date !== sourceConfig.compatibility_date) {
    stop("COMPATIBILITY_DATE_DRIFT", "active Worker compatibility date differs from current source");
  }

  const expectedFlags = Array.isArray(sourceConfig.compatibility_flags)
    ? [...sourceConfig.compatibility_flags].sort()
    : [];
  const observedFlags = Array.isArray(runtime.compatibility_flags)
    ? [...runtime.compatibility_flags].sort()
    : [];
  if (JSON.stringify(observedFlags) !== JSON.stringify(expectedFlags)) {
    stop("COMPATIBILITY_FLAGS_DRIFT", "active Worker compatibility flags differ from current source");
  }

  const scriptEtag = version?.resources?.script?.etag;
  if (typeof scriptEtag !== "string" || scriptEtag.length === 0) {
    stop("SCRIPT_IDENTITY_MISSING", "active Worker version lacks script identity metadata");
  }
}

async function verifyWorkerState(a) {
  const deployments = await cfWorkers(`/workers/scripts/${WORKER_NAME}/deployments`);
  const current = deployments?.deployments?.[0];
  if (
    !current ||
    current.id !== a.deployment ||
    !Array.isArray(current.versions) ||
    current.versions.length !== 1 ||
    current.versions[0]?.version_id !== a.version ||
    current.versions[0]?.percentage !== 100
  ) {
    stop("ACTIVE_DEPLOYMENT_VERSION_DRIFT", "active Worker is not the exact expected single-version 100-percent deployment");
  }

  const version = await cfWorkers(`/workers/scripts/${WORKER_NAME}/versions/${a.version}`);
  if (version?.id !== a.version) stop("VERSION_ID_DRIFT", "version detail does not match expected active version");
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  const digest = assertBindings(bindings, a.nonTargetBindingsSha256);
  await assertRuntimeConfig(version);
  return { digest };
}

async function main() {
  const a = inputs();
  assertInputs(a);
  assertExecutionContext(a);
  assertCredentials();
  await assertGitHubEvidence(a);
  const state = await verifyWorkerState(a);

  console.log("PHASE5_WORKER_POST_ACTIVATION_VERIFY=PASS");
  console.log(`SOURCE_SHA=${a.sha}`);
  console.log(`CI_RUN_ID=${a.ciRun}`);
  console.log(`ACTIVE_DEPLOYMENT=${a.deployment}`);
  console.log(`ACTIVE_VERSION=${a.version}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log("INGEST_BINDING=PLAIN_TEXT_TRUE");
  console.log("VERIFICATION_KEY_BINDING=PRESENT_PROTECTED_SECRET_TEXT_VALUE_UNOBSERVED");
  console.log("CONTROL_DB_BINDING=VALID_UNCHANGED");
  console.log(`NON_TARGET_BINDINGS_SHA256=${state.digest}`);
  console.log("SCRIPT_RUNTIME_CONFIG=EXPECTED");
  emitZeroMutationMarkers();
}

main().catch((error) => {
  if (!process.exitCode) {
    console.error("PHASE5_WORKER_POST_ACTIVATION_VERIFY=STOP");
    console.error("STOP=UNEXPECTED_VERIFIER_ERROR");
    emitZeroMutationMarkers(console.error);
    console.error(error instanceof Error ? error.message : "unexpected verifier error");
    process.exitCode = 1;
  }
});
