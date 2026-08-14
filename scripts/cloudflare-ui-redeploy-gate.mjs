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

const AUTH_PREFIX = `authorize Phase 2 Cloudflare UI redeploy ${HOSTNAME} `;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN_ID_PATTERN = /^[0-9a-f]{40}$/;

let deployStarted = false;

function parseArgs(argv) {
  const out = {
    mode: "plan",
    sha: "",
    ci: "",
    currentVersion: "",
    currentDeployment: "",
    domainId: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode") out.mode = argv[++index] ?? "";
    else if (argv[index] === "--expected-sha") out.sha = argv[++index] ?? "";
    else if (argv[index] === "--expected-ci-run-id") out.ci = argv[++index] ?? "";
    else if (argv[index] === "--expected-current-version-id") out.currentVersion = argv[++index] ?? "";
    else if (argv[index] === "--expected-current-deployment-id") out.currentDeployment = argv[++index] ?? "";
    else if (argv[index] === "--expected-domain-id") out.domainId = argv[++index] ?? "";
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
  console.log("WORKER_REDEPLOY=NOT_EXECUTED_IN_PLAN");
  console.log("PUBLIC_ROUTING_CHANGE=NO");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("CUSTOM_DOMAIN=EXACT_EXISTING_DOMAIN_REQUIRED");
  console.log("CREDENTIAL_MODEL=SINGLE_TEMPORARY_SETUP_TOKEN");
  console.log(
    `OWNER_AUTHORIZATION_FORMAT=${AUTH_PREFIX}<exact-main-sha> ci <exact-ci-run-id> version <current-version-id> deployment <current-deployment-id> domain <domain-id>`,
  );
  console.log("NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES");
}

function assertVersionId(value, code, label) {
  if (!UUID_PATTERN.test(value)) stop(code, `${label} must be a lowercase UUID`);
}

async function targetDomains(apiToken) {
  const domains = await cfGet(apiToken, `/workers/domains?hostname=${encodeURIComponent(HOSTNAME)}`);
  if (!Array.isArray(domains)) stop("TARGET_DOMAIN_INVENTORY_INVALID", "target domain inventory was not an array");
  return domains;
}

function exactDomain(domains, expectedDomainId, codePrefix) {
  const matches = domains.filter(
    (domain) =>
      domain?.id === expectedDomainId &&
      domain?.hostname === HOSTNAME &&
      domain?.service === WORKER_NAME &&
      domain?.zone_name === ZONE_NAME,
  );
  if (domains.length !== 1 || matches.length !== 1) {
    stop(`${codePrefix}_DOMAIN_STATE`, "exact reviewed Custom Domain state was not uniquely proven");
  }
  return matches[0];
}

async function assertExactDomain(apiToken, expectedDomainId, codePrefix) {
  const serviceDomain = exactDomain(await listDomains(apiToken), expectedDomainId, `${codePrefix}_SERVICE`);
  const targetDomain = exactDomain(await targetDomains(apiToken), expectedDomainId, `${codePrefix}_TARGET`);
  if (serviceDomain.id !== targetDomain.id) {
    stop(`${codePrefix}_DOMAIN_ID_MISMATCH`, "service and target domain inventories disagreed");
  }
  return serviceDomain;
}

async function assertExpectedActive(apiToken, expectedVersionId, expectedDeploymentId, codePrefix) {
  const active = singleDeploymentVersion(await listDeployments(apiToken), codePrefix);
  if (active.versionId !== expectedVersionId || active.deploymentId !== expectedDeploymentId) {
    stop(`${codePrefix}_ACTIVE_STATE`, "active Worker version/deployment differs from authorized prewrite state");
  }
  assertRequiredBindings(await versionDetail(apiToken, expectedVersionId), codePrefix);
  await assertSubdomainDisabled(apiToken, codePrefix);
  return active;
}

function versionIdSet(versions, codePrefix) {
  const ids = versions.map((version) => version?.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    stop(`${codePrefix}_VERSION_SET_INVALID`, "Worker version inventory contained invalid or duplicate ids");
  }
  return new Set(ids);
}

async function apply(args) {
  assertBaseInputs(args.sha, args.ci);
  assertVersionId(args.currentVersion, "CURRENT_VERSION_ID_INVALID", "current version id");
  assertVersionId(args.currentDeployment, "CURRENT_DEPLOYMENT_ID_INVALID", "current deployment id");
  if (!DOMAIN_ID_PATTERN.test(args.domainId)) {
    stop("DOMAIN_ID_INVALID", "domain id must be exactly 40 lowercase hex characters");
  }

  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";

  if (account !== ACCOUNT_ID) stop("ACCOUNT_ID_INVALID", "Cloudflare account does not match reviewed production account");
  if (!apiToken) stop("API_TOKEN_REQUIRED", "temporary rozkalns-control-setup Cloudflare API token is required");

  const expectedAuthorization =
    `${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${args.currentVersion} ` +
    `deployment ${args.currentDeployment} domain ${args.domainId}`;
  if (authorization !== expectedAuthorization) {
    stop("OWNER_AUTHORIZATION_INVALID", "redeploy authorization must match exact main, CI and current Cloudflare state");
  }

  assertRepo(args.sha);
  await assertFixtureSourceConfig();
  await assertCi(args.sha, args.ci);
  run("npm", ["run", "check"], { inherit: true });

  const beforeVersions = await listVersions(apiToken);
  const beforeIds = versionIdSet(beforeVersions, "PREWRITE");
  await assertExpectedActive(apiToken, args.currentVersion, args.currentDeployment, "PREWRITE");
  await assertExactDomain(apiToken, args.domainId, "PREWRITE");

  assertRepo(args.sha);
  await assertFixtureSourceConfig();
  await assertCi(args.sha, args.ci);
  await assertExpectedActive(apiToken, args.currentVersion, args.currentDeployment, "FINAL_PREWRITE");
  await assertExactDomain(apiToken, args.domainId, "FINAL_PREWRITE");

  const finalBeforeIds = versionIdSet(await listVersions(apiToken), "FINAL_PREWRITE");
  if (beforeIds.size !== finalBeforeIds.size || [...beforeIds].some((id) => !finalBeforeIds.has(id))) {
    stop("FINAL_PREWRITE_VERSION_SET_CHANGED", "Worker version inventory changed during redeploy preflight");
  }

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
    { inherit: true, env: childEnvironment(apiToken) },
  );

  const afterVersions = await listVersions(apiToken);
  const newVersions = afterVersions.filter(
    (version) => typeof version?.id === "string" && !beforeIds.has(version.id),
  );
  if (newVersions.length !== 1) {
    stop("POST_VERIFY_NEW_VERSION", "expected exactly one newly observed Worker version after redeploy");
  }
  const newVersionId = newVersions[0].id;

  const active = singleDeploymentVersion(await listDeployments(apiToken), "POST_VERIFY");
  if (active.versionId !== newVersionId) {
    stop("POST_VERIFY_ACTIVE_VERSION", "new current-main version is not receiving 100% of Worker deployment traffic");
  }
  if (active.deploymentId === args.currentDeployment) {
    stop("POST_VERIFY_DEPLOYMENT_ID", "deployment id did not change after redeploy");
  }

  assertRequiredBindings(await versionDetail(apiToken, newVersionId), "POST_VERIFY");
  await assertSubdomainDisabled(apiToken, "POST_VERIFY");
  const domain = await assertExactDomain(apiToken, args.domainId, "POST_VERIFY");

  console.log("UI_REDEPLOY_GATE=PASS");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log(`NEW_VERSION_ID=${newVersionId}`);
  console.log(`ACTIVE_DEPLOYMENT_ID=${active.deploymentId}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log(`CUSTOM_DOMAIN=${domain.hostname}`);
  console.log(`DOMAIN_ID=${domain.id}`);
  console.log("PUBLIC_UI_MODE=FIXTURE_ONLY");
  console.log("LIVE_GITHUB_RECONCILIATION=DISABLED");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("PUBLIC_ROUTING_CHANGE=NO_EXISTING_DOMAIN_PRESERVED");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") plan();
  else await apply(args);
} catch {
  if (deployStarted) console.error("POST_DEPLOY_STATE=REVIEW_REQUIRED");
  if (process.exitCode !== 1) {
    console.error("UNEXPECTED_FAILURE: sanitized UI redeploy gate failure");
    process.exitCode = 1;
  }
}
