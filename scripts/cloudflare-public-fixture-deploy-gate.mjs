#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  ACCOUNT_ID,
  BOOTSTRAP_VERSION_ID,
  NON_DEPLOYED_VERSION_ID,
  WORKER_NAME,
  assertBaseInputs,
  assertExactActiveFixtureVersion,
  assertExactMainCi,
  assertExactRepositoryState,
  assertReviewedBaseline,
  assertSourceFixtureConfig,
  cleanEnv,
  listVersions,
  stop,
  wranglerPath,
} from "./cloudflare-public-rollout-common.mjs";

const AUTH_PREFIX = "authorize Phase 2 public fixture non-routable deploy ";

function parseArgs(argv) {
  const args = { mode: "plan", sha: "", ci: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") args.mode = argv[++index] ?? "";
    else if (arg === "--expected-sha") args.sha = argv[++index] ?? "";
    else if (arg === "--expected-ci-run-id") args.ci = argv[++index] ?? "";
    else stop("ARGUMENT_INVALID", `unsupported argument ${arg}`);
  }
  if (args.mode !== "plan" && args.mode !== "apply") {
    stop("MODE_INVALID", "mode must be plan or apply");
  }
  return args;
}

function printPlan() {
  console.log("MODE=PLAN");
  console.log(`WORKER=${WORKER_NAME}`);
  console.log(`ACCOUNT_ID=${ACCOUNT_ID}`);
  console.log(`BASELINE_BOOTSTRAP_VERSION=${BOOTSTRAP_VERSION_ID}`);
  console.log(`BASELINE_NON_DEPLOYED_VERSION=${NON_DEPLOYED_VERSION_ID}`);
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("AUTHORIZED_APPLY=WRANGLER_DEPLOY_STRICT_EXACT_MAIN");
  console.log("PUBLIC_ROUTING_CHANGE=NO");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("LIVE_GITHUB_RECONCILIATION=DISABLED");
  console.log(`OWNER_AUTHORIZATION_FORMAT=${AUTH_PREFIX}<exact-main-sha> ci <exact-ci-run-id>`);
  console.log("NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES");
}

function childEnvironment(token) {
  return cleanEnv({
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  });
}

async function apply(args) {
  assertBaseInputs(args.sha, args.ci);
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";
  if (!token) stop("CLOUDFLARE_TOKEN_REQUIRED", "apply requires a Workers Scripts write-capable API token");
  if (authorization !== `${AUTH_PREFIX}${args.sha} ci ${args.ci}`) {
    stop("OWNER_AUTHORIZATION_INVALID", "owner authorization does not match exact main SHA and CI run");
  }

  assertExactRepositoryState(args.sha);
  await assertSourceFixtureConfig();
  await assertExactMainCi(args.sha, args.ci);
  await assertReviewedBaseline(token);

  runLocalValidation();

  // Re-resolve the mutable trust boundary immediately before the only Cloudflare write.
  assertExactRepositoryState(args.sha);
  await assertExactMainCi(args.sha, args.ci);
  await assertReviewedBaseline(token);

  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("DEPLOY_STARTED=YES");

  const result = spawnSync(
    wranglerPath(),
    [
      "deploy",
      "--name",
      WORKER_NAME,
      "--strict",
      "--experimental-provision=false",
      "--experimental-auto-create=false",
      "--install-skills=false",
    ],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: childEnvironment(token),
    },
  );

  if (result.error || result.status !== 0) {
    console.error("POST_DEPLOY_STATE=RECONCILIATION_REQUIRED");
    stop("PUBLIC_FIXTURE_DEPLOY_FAILED", "Wrangler deploy failed after authorization was consumed; do not blind retry");
  }

  try {
    await delay(2000);
    const versions = await listVersions(token);
    const known = new Set([BOOTSTRAP_VERSION_ID, NON_DEPLOYED_VERSION_ID]);
    const unknown = versions.filter((version) => typeof version?.id === "string" && !known.has(version.id));
    if (versions.length !== 3 || unknown.length !== 1) {
      stop("POST_VERIFY_VERSION_SET", "expected exactly one new version on top of the reviewed two-version baseline");
    }
    const deployedVersionId = unknown[0].id;
    const { active } = await assertExactActiveFixtureVersion(token, deployedVersionId, {
      domainMustBeAbsent: true,
    });

    console.log("PUBLIC_FIXTURE_DEPLOY_GATE=PASS");
    console.log(`DEPLOYED_VERSION_ID=${deployedVersionId}`);
    console.log(`ACTIVE_DEPLOYMENT_ID=${active.id}`);
    console.log("ACTIVE_TRAFFIC_PERCENT=100");
    console.log("PUBLIC_ROUTING_CHANGE=NO");
    console.log("WORKERS_DEV=DISABLED");
    console.log("PREVIEW_URLS=DISABLED");
    console.log("LIVE_GITHUB_RECONCILIATION=DISABLED");
    console.log("PRIVATE_KEY_BINDING=PROVEN");
    console.log("D1_BINDING=PROVEN");
  } catch (error) {
    console.error("POST_DEPLOY_STATE=RECONCILIATION_REQUIRED");
    throw error;
  }
}

function runLocalValidation() {
  const result = spawnSync("npm", ["run", "check"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: cleanEnv(),
  });
  if (result.error || result.status !== 0) {
    stop("LOCAL_VALIDATION_FAILED", "npm run check failed before deploy");
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") printPlan();
  else await apply(args);
} catch {
  if (process.exitCode !== 1) {
    console.error("UNEXPECTED_FAILURE: sanitized public fixture deploy gate failure");
    process.exitCode = 1;
  }
}
