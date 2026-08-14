#!/usr/bin/env node
import {
  ACCOUNT_ID,
  HOSTNAME,
  WORKER_NAME,
  ZONE_NAME,
  assertBaseInputs,
  assertCi,
  assertFixtureSourceConfig,
  assertRepo,
  assertRequiredBindings,
  assertSubdomainDisabled,
  cfGet,
  cfWrite,
  listDeployments,
  listDomains,
  singleDeploymentVersion,
  stop,
  versionDetail,
} from "./cloudflare-ui-rollout-shared.mjs";

const AUTH_PREFIX = `authorize Phase 2 Cloudflare UI domain ${HOSTNAME} `;
const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let attachStarted = false;

function parseArgs(argv) {
  const out = { mode: "plan", sha: "", ci: "", version: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode") out.mode = argv[++index] ?? "";
    else if (argv[index] === "--expected-sha") out.sha = argv[++index] ?? "";
    else if (argv[index] === "--expected-ci-run-id") out.ci = argv[++index] ?? "";
    else if (argv[index] === "--expected-version-id") out.version = argv[++index] ?? "";
    else stop("ARGUMENT_INVALID", `unsupported argument ${argv[index]}`);
  }
  if (out.mode !== "plan" && out.mode !== "apply") stop("MODE_INVALID", "mode must be plan or apply");
  return out;
}

function plan() {
  console.log("MODE=PLAN");
  console.log(`WORKER=${WORKER_NAME}`);
  console.log(`ACCOUNT_ID=${ACCOUNT_ID}`);
  console.log(`CUSTOM_DOMAIN=${HOSTNAME}`);
  console.log(`ZONE_NAME=${ZONE_NAME}`);
  console.log("PUBLIC_UI_MODE=FIXTURE_ONLY");
  console.log("LIVE_GITHUB_RECONCILIATION=DISABLED");
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("DOMAIN_ATTACH=NOT_EXECUTED_IN_PLAN");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log(`OWNER_AUTHORIZATION_FORMAT=${AUTH_PREFIX}<exact-main-sha> ci <exact-ci-run-id> version <exact-version-id>`);
  console.log("NO_BLIND_RETRY_AFTER_DOMAIN_ATTACH_STARTED=YES");
}

async function accountDomainsForTarget(readToken) {
  const domains = await cfGet(readToken, `/workers/domains?hostname=${encodeURIComponent(HOSTNAME)}`);
  if (!Array.isArray(domains)) stop("TARGET_DOMAIN_INVENTORY_INVALID", "target domain inventory was not an array");
  return domains;
}

function assertTargetAbsent(domains, codePrefix) {
  if (domains.some((domain) => domain?.hostname === HOSTNAME)) {
    stop(`${codePrefix}_TARGET_DOMAIN_PRESENT`, "target hostname is already attached to a Worker");
  }
}

async function assertExpectedActiveVersion(readToken, expectedVersionId, codePrefix) {
  const active = singleDeploymentVersion(await listDeployments(readToken), codePrefix);
  if (active.versionId !== expectedVersionId) {
    stop(`${codePrefix}_ACTIVE_VERSION_MISMATCH`, "active deployment does not match the separately authorized Worker version");
  }
  assertRequiredBindings(await versionDetail(readToken, expectedVersionId), codePrefix);
  await assertSubdomainDisabled(readToken, codePrefix);
  return active;
}

async function apply(args) {
  assertBaseInputs(args.sha, args.ci);
  if (!VERSION_ID_PATTERN.test(args.version)) {
    stop("VERSION_ID_INVALID", "expected version id must be a lowercase UUID");
  }

  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const readToken = process.env.CLOUDFLARE_READ_TOKEN ?? "";
  const writeToken = process.env.CLOUDFLARE_WRITE_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";

  if (account !== ACCOUNT_ID) stop("ACCOUNT_ID_INVALID", "Cloudflare account does not match reviewed production account");
  if (!readToken) stop("READ_TOKEN_REQUIRED", "Workers Scripts Read token is required");
  if (!writeToken) stop("WRITE_TOKEN_REQUIRED", "Workers Scripts Write token is required");
  if (readToken === writeToken) stop("TOKEN_SEPARATION_REQUIRED", "read and write tokens must be distinct");
  if (authorization !== `${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${args.version}`) {
    stop("OWNER_AUTHORIZATION_INVALID", "domain authorization must match exact main SHA, CI and deployed version");
  }

  assertRepo(args.sha);
  await assertFixtureSourceConfig();
  await assertCi(args.sha, args.ci);
  const beforeActive = await assertExpectedActiveVersion(readToken, args.version, "PREWRITE");
  const serviceDomains = await listDomains(readToken);
  if (serviceDomains.length !== 0) stop("PREWRITE_WORKER_DOMAIN_PRESENT", "Worker already has a Custom Domain");
  assertTargetAbsent(await accountDomainsForTarget(readToken), "PREWRITE");

  assertRepo(args.sha);
  await assertFixtureSourceConfig();
  await assertCi(args.sha, args.ci);
  const finalActive = await assertExpectedActiveVersion(readToken, args.version, "FINAL_PREWRITE");
  if (finalActive.deploymentId !== beforeActive.deploymentId) {
    stop("FINAL_PREWRITE_DEPLOYMENT_CHANGED", "active deployment changed during domain preflight");
  }
  if ((await listDomains(readToken)).length !== 0) stop("FINAL_PREWRITE_WORKER_DOMAIN_PRESENT", "Worker gained a Custom Domain during preflight");
  assertTargetAbsent(await accountDomainsForTarget(readToken), "FINAL_PREWRITE");

  console.log("DOMAIN_ATTACH_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("NO_BLIND_RETRY_IF_STOP_AFTER_DOMAIN_ATTACH_STARTED=YES");
  attachStarted = true;

  const attached = await cfWrite(writeToken, "/workers/domains", "PUT", {
    hostname: HOSTNAME,
    service: WORKER_NAME,
    zone_name: ZONE_NAME,
  });
  if (attached?.hostname !== HOSTNAME || attached?.service !== WORKER_NAME || attached?.zone_name !== ZONE_NAME) {
    stop("DOMAIN_ATTACH_RESPONSE_INVALID", "Custom Domain attach response did not match the reviewed target");
  }

  const afterDomains = await accountDomainsForTarget(readToken);
  const matches = afterDomains.filter(
    (domain) =>
      domain?.hostname === HOSTNAME &&
      domain?.service === WORKER_NAME &&
      domain?.zone_name === ZONE_NAME &&
      typeof domain?.id === "string" &&
      domain.id.length > 0,
  );
  if (matches.length !== 1) {
    stop("POST_VERIFY_DOMAIN_INVALID", "target Custom Domain was not uniquely proven after attach");
  }

  const afterActive = await assertExpectedActiveVersion(readToken, args.version, "POST_VERIFY");
  if (afterActive.deploymentId !== beforeActive.deploymentId) {
    stop("POST_VERIFY_DEPLOYMENT_CHANGED", "domain attach unexpectedly changed the active Worker deployment");
  }

  console.log("UI_DOMAIN_GATE=PASS");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log(`CUSTOM_DOMAIN=${HOSTNAME}`);
  console.log(`DOMAIN_ID=${matches[0].id}`);
  console.log(`ACTIVE_VERSION_ID=${args.version}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log("PUBLIC_UI_MODE=FIXTURE_ONLY");
  console.log("LIVE_GITHUB_RECONCILIATION=DISABLED");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("PUBLIC_ROUTING_CHANGE=YES_AUTHORIZED_DOMAIN_ONLY");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") plan();
  else await apply(args);
} catch {
  if (attachStarted) console.error("POST_DOMAIN_ATTACH_STATE=REVIEW_REQUIRED");
  if (process.exitCode !== 1) {
    console.error("UNEXPECTED_FAILURE: sanitized UI domain gate failure");
    process.exitCode = 1;
  }
}
