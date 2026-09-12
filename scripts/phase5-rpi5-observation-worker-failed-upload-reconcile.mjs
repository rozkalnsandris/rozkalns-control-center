#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const REPO = "rozkalnsandris/rozkalns-control-center";
const WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-worker-failed-upload-reconcile.yml";
const ACTIVATION_WORKFLOW_PATH = ".github/workflows/phase5-rpi5-observation-worker-activate-live.yml";
const EXPECTED_WORKFLOW_REF = `${REPO}/${WORKFLOW_PATH}@refs/heads/main`;
const ACTIVATION_WORKFLOW_NAME = "Phase 5 RPi5 observation Worker activate";
const ACTIVATION_JOB_NAME = "one-shot exact-candidate Worker activation";
const ACTIVATION_STEP_NAME = "Execute one-shot Worker activation mutation class";
const CF_ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
const WORKER_NAME = "rozkalns-control";
const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
const INGEST_BINDING = "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED";
const KEY_BINDING = "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS";
const CLOCK_SKEW_MS = 30_000;

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
  stream("WORKER_VERSION_DELETE=NO");
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
  console.error("PHASE5_WORKER_FAILED_UPLOAD_RECONCILE=STOP");
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
      "User-Agent": "rozkalns-control-phase5-worker-failed-upload-reconcile",
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
    failedRun: input("FAILED_ACTIVATION_RUN"),
    deployment: input("EXPECTED_DEPLOYMENT"),
    version: input("EXPECTED_VERSION"),
    nonTargetBindingsSha256: input("EXPECTED_NON_TARGET_BINDINGS_SHA256"),
  };
}

function assertInputs(a) {
  if (!SHA1.test(a.sha)) stop("APPROVED_SHA_INVALID", "approved SHA must be 40 lowercase hex characters");
  if (!RUN_ID.test(a.ciRun) || !RUN_ID.test(a.failedRun)) {
    stop("RUN_ID_INVALID", "CI and failed activation run ids must be positive integers");
  }
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
  if (!valid) stop("EXECUTION_CONTEXT_INVALID", "reconciliation requires exact default-branch GitHub-hosted workflow context");
}

function assertCredentials() {
  if (!input("GITHUB_TOKEN")) stop("GITHUB_TOKEN_REQUIRED", "GitHub read token is required");
  if (!input("CLOUDFLARE_WORKERS_READ_TOKEN")) {
    stop("CLOUDFLARE_WORKERS_READ_TOKEN_REQUIRED", "Workers Scripts read token is required");
  }
}

function parseInstant(value, code) {
  const millis = Date.parse(value ?? "");
  if (!Number.isFinite(millis)) stop(code, "timestamp is missing or invalid");
  return millis;
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

  const failed = await gh(`/actions/runs/${a.failedRun}`);
  if (
    failed?.name !== ACTIVATION_WORKFLOW_NAME ||
    failed?.path !== ACTIVATION_WORKFLOW_PATH ||
    failed?.head_branch !== "main" ||
    failed?.head_sha !== a.sha ||
    failed?.event !== "workflow_dispatch" ||
    failed?.status !== "completed" ||
    failed?.conclusion !== "failure" ||
    failed?.run_attempt !== 1
  ) {
    stop("FAILED_ACTIVATION_RUN_INVALID", "named run is not the exact first-attempt failed activation on approved main");
  }

  const jobs = await gh(`/actions/runs/${a.failedRun}/jobs?per_page=100`);
  const matchingJobs = Array.isArray(jobs?.jobs)
    ? jobs.jobs.filter((job) => job?.name === ACTIVATION_JOB_NAME && job?.head_sha === a.sha)
    : [];
  if (matchingJobs.length !== 1 || matchingJobs[0]?.conclusion !== "failure") {
    stop("FAILED_ACTIVATION_JOB_INVALID", "failed activation must contain exactly one matching failed job");
  }

  const steps = Array.isArray(matchingJobs[0]?.steps) ? matchingJobs[0].steps : [];
  const mutationSteps = steps.filter((step) => step?.name === ACTIVATION_STEP_NAME);
  if (mutationSteps.length !== 1 || mutationSteps[0]?.conclusion !== "failure") {
    stop("FAILED_MUTATION_STEP_INVALID", "failed activation mutation step is missing or not uniquely failed");
  }

  const startedMs = parseInstant(mutationSteps[0].started_at, "FAILED_MUTATION_STEP_START_INVALID");
  const completedMs = parseInstant(mutationSteps[0].completed_at, "FAILED_MUTATION_STEP_END_INVALID");
  if (completedMs < startedMs) stop("FAILED_MUTATION_STEP_WINDOW_INVALID", "failed mutation step end precedes start");

  return {
    stepStartedAt: new Date(startedMs).toISOString(),
    stepCompletedAt: new Date(completedMs).toISOString(),
    windowStartMs: startedMs - CLOCK_SKEW_MS,
    windowEndMs: completedMs + CLOCK_SKEW_MS,
  };
}

function nonTargetBindingsDigest(bindings) {
  const filtered = bindings
    .filter((binding) => binding?.name !== INGEST_BINDING)
    .map(canonical)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return sha256(JSON.stringify(filtered));
}

function assertCandidateBindings(bindings, expectedDigest) {
  const db = bindings.filter((binding) => binding?.name === "CONTROL_DB");
  if (db.length !== 1 || db[0]?.type !== "d1" || (db[0]?.database_id ?? db[0]?.id ?? "") !== DB_ID) {
    stop("CANDIDATE_CONTROL_DB_BINDING_DRIFT", "candidate CONTROL_DB identity differs from reviewed production resource");
  }

  const key = bindings.filter((binding) => binding?.name === KEY_BINDING);
  if (
    key.length !== 1 ||
    key[0]?.type !== "secret_text" ||
    Object.prototype.hasOwnProperty.call(key[0], "text") ||
    Object.prototype.hasOwnProperty.call(key[0], "value")
  ) {
    stop("CANDIDATE_VERIFICATION_KEY_BINDING_INVALID", "candidate verification key binding is missing, exposed, or not protected secret_text");
  }

  const ingest = bindings.filter((binding) => binding?.name === INGEST_BINDING);
  if (ingest.length !== 1 || ingest[0]?.type !== "plain_text" || ingest[0]?.text !== "true") {
    stop("CANDIDATE_INGEST_BINDING_INVALID", "candidate ingest binding is not exact plain-text true");
  }

  const digest = nonTargetBindingsDigest(bindings);
  if (digest !== expectedDigest) {
    stop("CANDIDATE_NON_TARGET_BINDING_DIGEST_DRIFT", "candidate non-target binding inventory differs from reviewed baseline");
  }
  return digest;
}

async function assertRuntimeConfig(version) {
  const sourceConfig = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const runtime = version?.resources?.script_runtime;
  if (!runtime || runtime.compatibility_date !== sourceConfig.compatibility_date) {
    stop("CANDIDATE_COMPATIBILITY_DATE_DRIFT", "candidate compatibility date differs from approved source");
  }
  const expectedFlags = Array.isArray(sourceConfig.compatibility_flags) ? [...sourceConfig.compatibility_flags].sort() : [];
  const observedFlags = Array.isArray(runtime.compatibility_flags) ? [...runtime.compatibility_flags].sort() : [];
  if (JSON.stringify(observedFlags) !== JSON.stringify(expectedFlags)) {
    stop("CANDIDATE_COMPATIBILITY_FLAGS_DRIFT", "candidate compatibility flags differ from approved source");
  }
  const scriptEtag = version?.resources?.script?.etag;
  if (typeof scriptEtag !== "string" || scriptEtag.length === 0) {
    stop("CANDIDATE_SCRIPT_IDENTITY_MISSING", "candidate version lacks script identity metadata");
  }
}

async function assertActiveBaseline(a) {
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
    stop("ACTIVE_STATE_CHANGED_UNEXPECTEDLY", "active Worker deployment/version differs from the pre-attempt baseline");
  }
}

function candidateWindowItems(items, a, evidence) {
  return items.filter((item) => {
    if (!UUID.test(item?.id ?? "") || item.id === a.version) return false;
    if (item?.metadata?.source !== "wrangler") return false;
    const createdMs = Date.parse(item?.metadata?.created_on ?? "");
    return Number.isFinite(createdMs) && createdMs >= evidence.windowStartMs && createdMs <= evidence.windowEndMs;
  });
}

async function reconcileVersionInventory(a, evidence) {
  const page = await cfWorkers(`/workers/scripts/${WORKER_NAME}/versions?per_page=100`);
  const items = page?.items;
  if (!Array.isArray(items)) stop("VERSION_INVENTORY_INVALID", "Worker version inventory did not contain result.items");

  const candidates = candidateWindowItems(items, a, evidence);
  if (candidates.length > 1) {
    stop("AMBIGUOUS_MULTIPLE_CANDIDATES", "multiple distinct Wrangler versions fall inside the failed mutation-step attribution window");
  }
  if (candidates.length === 0) return { classification: "NO_POST_ATTEMPT_VERSION_OBSERVED" };

  const candidate = candidates[0];
  const detail = await cfWorkers(`/workers/scripts/${WORKER_NAME}/versions/${candidate.id}`);
  if (detail?.id !== candidate.id) stop("CANDIDATE_VERSION_ID_DRIFT", "candidate detail does not match inventory identity");
  if (detail?.metadata?.source !== "wrangler") stop("CANDIDATE_SOURCE_DRIFT", "candidate detail source is not Wrangler");
  const detailCreatedMs = parseInstant(detail?.metadata?.created_on, "CANDIDATE_CREATED_ON_INVALID");
  if (detailCreatedMs < evidence.windowStartMs || detailCreatedMs > evidence.windowEndMs) {
    stop("CANDIDATE_TIME_WINDOW_DRIFT", "candidate detail creation time falls outside failed mutation-step attribution window");
  }

  const bindings = Array.isArray(detail?.resources?.bindings) ? detail.resources.bindings : [];
  const digest = assertCandidateBindings(bindings, a.nonTargetBindingsSha256);
  await assertRuntimeConfig(detail);
  return {
    classification: "EXACTLY_ONE_ATTRIBUTABLE_INACTIVE_CANDIDATE",
    version: candidate.id,
    createdOn: new Date(detailCreatedMs).toISOString(),
    digest,
  };
}

async function main() {
  const a = inputs();
  assertInputs(a);
  assertExecutionContext(a);
  assertCredentials();
  const evidence = await assertGitHubEvidence(a);
  await assertActiveBaseline(a);
  const result = await reconcileVersionInventory(a, evidence);

  console.log("PHASE5_WORKER_FAILED_UPLOAD_RECONCILE=PASS");
  console.log(`SOURCE_SHA=${a.sha}`);
  console.log(`CI_RUN_ID=${a.ciRun}`);
  console.log(`FAILED_ACTIVATION_RUN=${a.failedRun}`);
  console.log(`FAILED_MUTATION_STEP_STARTED_AT=${evidence.stepStartedAt}`);
  console.log(`FAILED_MUTATION_STEP_COMPLETED_AT=${evidence.stepCompletedAt}`);
  console.log(`ACTIVE_DEPLOYMENT=${a.deployment}`);
  console.log(`ACTIVE_VERSION=${a.version}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log(`RECONCILIATION_CLASSIFICATION=${result.classification}`);
  console.log("ATTRIBUTION_CLOCK_SKEW_SECONDS=30");
  console.log("ATTRIBUTION_MESSAGE_OBSERVABILITY=NOT_AVAILABLE_ON_STABLE_SCRIPT_VERSIONS_API");
  if (result.version) {
    console.log("ATTRIBUTION_BASIS=UNIQUE_WRANGLER_VERSION_IN_FAILED_MUTATION_STEP_WINDOW_PLUS_EXACT_CANDIDATE_INVARIANTS");
    console.log(`CANDIDATE_VERSION=${result.version}`);
    console.log(`CANDIDATE_CREATED_ON=${result.createdOn}`);
    console.log("CANDIDATE_STATE=INACTIVE");
    console.log("CANDIDATE_INGEST_BINDING=PLAIN_TEXT_TRUE");
    console.log("CANDIDATE_VERIFICATION_KEY_BINDING=PRESENT_PROTECTED_SECRET_TEXT_VALUE_UNOBSERVED");
    console.log("CANDIDATE_CONTROL_DB_BINDING=VALID_UNCHANGED");
    console.log(`CANDIDATE_NON_TARGET_BINDINGS_SHA256=${result.digest}`);
    console.log("CANDIDATE_SCRIPT_RUNTIME_CONFIG=EXPECTED");
  } else {
    console.log("ATTRIBUTION_BASIS=NO_DISTINCT_WRANGLER_VERSION_IN_FAILED_MUTATION_STEP_WINDOW");
    console.log("CANDIDATE_VERSION=NONE");
  }
  console.log("RECOVERY_MUTATION_AUTHORIZED=NO");
  emitZeroMutationMarkers();
}

main().catch((error) => {
  if (!process.exitCode) {
    console.error("PHASE5_WORKER_FAILED_UPLOAD_RECONCILE=STOP");
    console.error("STOP=UNEXPECTED_RECONCILER_ERROR");
    emitZeroMutationMarkers(console.error);
    console.error(error instanceof Error ? error.message : "unexpected reconciliation error");
    process.exitCode = 1;
  }
});
