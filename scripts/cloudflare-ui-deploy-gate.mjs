#!/usr/bin/env node
import {
  ACCOUNT_ID,
  BOOTSTRAP_VERSION_ID,
  SECOND_VERSION_ID,
  WORKER_NAME,
  assertBaseInputs,
  assertCi,
  assertFixtureSourceConfig,
  assertHistoricalPreDeployBaseline,
  assertNoWorkerDomains,
  assertRepo,
  assertRequiredBindings,
  assertSubdomainDisabled,
  childEnvironment,
  listDeployments,
  listDomains,
  listVersions,
  run,
  singleDeploymentVersion,
  stop,
  versionDetail,
  wranglerPath,
} from "./cloudflare-ui-rollout-shared.mjs";

const AUTH_PREFIX = "authorize Phase 2 Cloudflare non-routable UI deploy ";

let deployStarted = false;

function parseArgs(argv) {
  const out = { mode: "plan", sha: "", ci: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode") out.mode = argv[++index] ?? "";
    else if (argv[index] === "--expected-sha") out.sha = argv[++index] ?? "";
    else if (argv[index] === "--expected-ci-run-id") out.ci = argv[++index] ?? "";
    else stop("ARGUMENT_INVALID", `unsupported argument ${argv[index]}`);
  }
  if (out.mode !== "plan" && out.mode !== "apply") stop("MODE_INVALID", "mode must be plan or apply");
  return out;
}

function plan() {
  console.log("MODE=PLAN");
  console.log(`WORKER=${WORKER_NAME}`);
  console.log(`ACCOUNT_ID=${ACCOUNT_ID}`);
  console.log(`EXPECTED_EXISTING_VERSIONS=${BOOTSTRAP_VERSION_ID},${SECOND_VERSION_ID}`);
  console.log("PUBLIC_UI_MODE=FIXTURE_ONLY");
  console.log("LIVE_GITHUB_RECONCILIATION=DISABLED");
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("TRAFFIC_DEPLOYMENT=NOT_EXECUTED_IN_PLAN");
  console.log("PUBLIC_ROUTING_CHANGE=NO");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("CUSTOM_DOMAIN=ABSENT_REQUIRED");
  console.log(`OWNER_AUTHORIZATION_FORMAT=${AUTH_PREFIX}<exact-main-sha> ci <exact-ci-run-id>`);
  console.log("NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES");
}

async function apply(args) {
  assertBaseInputs(args.sha, args.ci);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const readToken = process.env.CLOUDFLARE_READ_TOKEN ?? "";
  const writeToken = process.env.CLOUDFLARE_WRITE_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";

  if (account !== ACCOUNT_ID) stop("ACCOUNT_ID_INVALID", "Cloudflare account does not match reviewed production account");
  if (!readToken) stop("READ_TOKEN_REQUIRED", "Workers Scripts Read token is required");
  if (!writeToken) stop("WRITE_TOKEN_REQUIRED", "Workers Scripts Write token is required");
  if (readToken === writeToken) stop("TOKEN_SEPARATION_REQUIRED", "read and write tokens must be distinct");
  if (authorization !== `${AUTH_PREFIX}${args.sha} ci ${args.ci}`) {
    stop("OWNER_AUTHORIZATION_INVALID", "one-shot authorization must match exact main SHA and CI run");
  }

  assertRepo(args.sha);
  await assertFixtureSourceConfig();
  await assertCi(args.sha, args.ci);
  run("npm", ["run", "check"], { inherit: true });

  const beforeVersions = await listVersions(readToken);
  const beforeDeployments = await listDeployments(readToken);
  assertHistoricalPreDeployBaseline(beforeVersions, beforeDeployments);
  await assertSubdomainDisabled(readToken, "PREWRITE");
  assertNoWorkerDomains(await listDomains(readToken), "PREWRITE");

  assertRepo(args.sha);
  await assertFixtureSourceConfig();
  await assertCi(args.sha, args.ci);
  assertHistoricalPreDeployBaseline(await listVersions(readToken), await listDeployments(readToken));
  await assertSubdomainDisabled(readToken, "FINAL_PREWRITE");
  assertNoWorkerDomains(await listDomains(readToken), "FINAL_PREWRITE");

  console.log("DEPLOY_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("NO_BLIND_RETRY_IF_STOP_AFTER_DEPLOY_STARTED=YES");
  deployStarted = true;

  run(
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
    { inherit: true, env: childEnvironment(writeToken) },
  );

  const afterVersions = await listVersions(readToken);
  const beforeIds = new Set([BOOTSTRAP_VERSION_ID, SECOND_VERSION_ID]);
  const newVersions = afterVersions.filter(
    (version) => typeof version?.id === "string" && !beforeIds.has(version.id),
  );
  if (afterVersions.length !== 3 || newVersions.length !== 1) {
    stop("POST_VERIFY_VERSION_SET", "expected exactly one new Worker version after current-main deploy");
  }
  const newVersionId = newVersions[0].id;

  const active = singleDeploymentVersion(await listDeployments(readToken), "POST_VERIFY");
  if (active.versionId !== newVersionId) {
    stop("POST_VERIFY_ACTIVE_VERSION", "new current-main version is not receiving 100% of Worker deployment traffic");
  }
  if (active.deploymentId === "ca152e0e-295c-47a0-8637-2cd146242e74") {
    stop("POST_VERIFY_DEPLOYMENT_ID", "deployment id did not change after deploy");
  }

  assertRequiredBindings(await versionDetail(readToken, newVersionId), "POST_VERIFY");
  await assertSubdomainDisabled(readToken, "POST_VERIFY");
  assertNoWorkerDomains(await listDomains(readToken), "POST_VERIFY");

  console.log("UI_DEPLOY_GATE=PASS");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log(`NEW_VERSION_ID=${newVersionId}`);
  console.log(`ACTIVE_DEPLOYMENT_ID=${active.deploymentId}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log("PUBLIC_UI_MODE=FIXTURE_ONLY");
  console.log("LIVE_GITHUB_RECONCILIATION=DISABLED");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("CUSTOM_DOMAIN=ABSENT");
  console.log("PUBLIC_ROUTING_CHANGE=NO");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") plan();
  else await apply(args);
} catch {
  if (deployStarted) console.error("POST_DEPLOY_STATE=REVIEW_REQUIRED");
  if (process.exitCode !== 1) {
    console.error("UNEXPECTED_FAILURE: sanitized UI deploy gate failure");
    process.exitCode = 1;
  }
}
