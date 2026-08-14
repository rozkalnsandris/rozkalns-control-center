#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import {
  ACCOUNT_ID,
  DB_ID,
  DB_NAME,
  HOSTNAME,
  SECRET_NAME,
  WORKER_NAME,
  WRANGLER_VERSION,
  ZONE_NAME,
  assertBaseInputs,
  assertCi,
  assertRepo,
  assertRequiredBindings,
  assertSubdomainDisabled,
  cfGet,
  childEnvironment,
  cleanEnv,
  listDeployments,
  listDomains,
  listVersions,
  run,
  singleDeploymentVersion,
  stop,
  versionDetail,
  wranglerPath,
} from "./cloudflare-ui-rollout-shared.mjs";

const AUTH_PREFIX = `authorize Phase 2 Cloudflare live read ${HOSTNAME} `;
const APP_CLIENT_ID = "Iv23likDoFtVeWBJfdFS";
const INSTALLATION_ID = "153121564";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MANAGED_REPOSITORIES = [
  "rozkalnsandris/hermes-tech",
  "rozkalnsandris/hermes-deals",
  "rozkalnsandris/rozkalns-cv",
  "rozkalnsandris/RPi5_main",
  "rozkalnsandris/ops-workflows",
  "rozkalnsandris/rozkalnsandris",
].sort();

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
  console.log("SOURCE_TARGET_MODE=LIVE_READ_ONLY");
  console.log("CURRENT_RUNTIME_MODE=FIXTURE_ONLY_REQUIRED");
  console.log("GITHUB_MUTATION=DISABLED");
  console.log("WEBHOOK_RUNTIME=DISABLED");
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("WORKER_DEPLOY=NOT_EXECUTED_IN_PLAN");
  console.log("PUBLIC_ROUTING_CHANGE=NO");
  console.log("CREDENTIAL_MODEL=SINGLE_TEMPORARY_SETUP_TOKEN");
  console.log("ACCESS_CANARY_AUTH=SHORT_LIVED_USER_TOKEN_REQUIRED");
  console.log("PREWRITE_ACCESS_CANARY=HEALTH_ROUTE");
  console.log("POSTVERIFY_ACCESS_CANARY=LIVE_DASHBOARD_ROUTE");
  console.log(
    `OWNER_AUTHORIZATION_FORMAT=${AUTH_PREFIX}<exact-main-sha> ci <exact-ci-run-id> version <current-version-id> deployment <current-deployment-id> domain <domain-id>`,
  );
  console.log("NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES");
}

function assertVersionId(value, code, label) {
  if (!UUID_PATTERN.test(value)) stop(code, `${label} must be a lowercase UUID`);
}

function assertDomainId(value) {
  const hasControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });

  if (typeof value !== "string" || value.length === 0 || value.length > 256 || hasControlCharacter) {
    stop("DOMAIN_ID_INVALID", "domain id must be a non-empty bounded opaque identifier");
  }
}

function sanitizedChildEnvironment(apiToken = "") {
  const env = apiToken ? childEnvironment(apiToken) : cleanEnv();
  delete env.CONTROL_ACCESS_TOKEN;
  return env;
}

function assertPlainTextBinding(detail, name, expected, codePrefix) {
  const bindings = detail?.resources?.bindings;
  if (!Array.isArray(bindings)) stop(`${codePrefix}_BINDINGS_INVALID`, "version bindings were not available");
  const matches = bindings.filter((binding) => binding?.name === name && binding?.type === "plain_text");
  if (matches.length !== 1 || matches[0]?.text !== expected) {
    stop(`${codePrefix}_${name}_BINDING`, `${name} plain-text binding did not match the reviewed value`);
  }
}

function assertVersionBindings(detail, expectedLiveRead, codePrefix) {
  assertRequiredBindings(detail, codePrefix);
  assertPlainTextBinding(detail, "GITHUB_APP_CLIENT_ID", APP_CLIENT_ID, codePrefix);
  assertPlainTextBinding(detail, "GITHUB_APP_INSTALLATION_ID", INSTALLATION_ID, codePrefix);
  assertPlainTextBinding(detail, "CONTROL_LIVE_READ_ENABLED", expectedLiveRead ? "true" : "false", codePrefix);
}

async function assertLiveSourceConfig() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) {
    stop("WRANGLER_PIN_INVALID", "repository Wrangler pin changed");
  }

  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  if (config?.name !== WORKER_NAME) stop("WORKER_NAME_INVALID", "Worker target changed");
  if (config?.workers_dev !== false) stop("WORKERS_DEV_NOT_DISABLED", "workers.dev must remain disabled");
  if (config?.preview_urls !== false) stop("PREVIEW_URLS_NOT_DISABLED", "Preview URLs must remain disabled");
  if (config?.vars?.GITHUB_APP_CLIENT_ID !== APP_CLIENT_ID) stop("APP_CLIENT_ID_INVALID", "GitHub App client id changed");
  if (config?.vars?.GITHUB_APP_INSTALLATION_ID !== INSTALLATION_ID) {
    stop("INSTALLATION_ID_INVALID", "GitHub App installation id changed");
  }
  if (config?.vars?.CONTROL_LIVE_READ_ENABLED !== "true") {
    stop("LIVE_READ_NOT_ENABLED", "live-read rollout requires CONTROL_LIVE_READ_ENABLED=true in reviewed source");
  }
  if (
    config?.assets?.directory !== "./dist/client" ||
    config?.assets?.not_found_handling !== "single-page-application" ||
    JSON.stringify(config?.assets?.run_worker_first) !== JSON.stringify(["/api/*"])
  ) {
    stop("ASSETS_CONFIG_INVALID", "reviewed SPA/API Static Assets routing configuration changed");
  }
  for (const forbidden of ["route", "routes", "triggers", "custom_domain", "custom_domains"]) {
    if (Object.hasOwn(config, forbidden)) stop("SOURCE_ROUTING_PRESENT", `${forbidden} is forbidden in live-read rollout source config`);
  }

  const requiredSecrets = config?.secrets?.required;
  if (!Array.isArray(requiredSecrets) || requiredSecrets.length !== 1 || requiredSecrets[0] !== SECRET_NAME) {
    stop("SECRET_CONTRACT_INVALID", "required GitHub App secret contract changed");
  }

  const d1 = Array.isArray(config?.d1_databases) ? config.d1_databases : [];
  if (
    d1.length !== 1 ||
    d1[0]?.binding !== "CONTROL_DB" ||
    d1[0]?.database_name !== DB_NAME ||
    d1[0]?.database_id !== DB_ID ||
    d1[0]?.migrations_dir !== "migrations"
  ) {
    stop("D1_BINDING_INVALID", "production D1 binding changed");
  }

  const version = run(wranglerPath(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "installed Wrangler version changed");
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

async function assertExpectedActive(apiToken, expectedVersionId, expectedDeploymentId, expectedLiveRead, codePrefix) {
  const active = singleDeploymentVersion(await listDeployments(apiToken), codePrefix);
  if (active.versionId !== expectedVersionId || active.deploymentId !== expectedDeploymentId) {
    stop(`${codePrefix}_ACTIVE_STATE`, "active Worker version/deployment differs from authorized prewrite state");
  }
  assertVersionBindings(await versionDetail(apiToken, expectedVersionId), expectedLiveRead, codePrefix);
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

async function readAccessJson(codePrefix, path, accessToken, label) {
  let response;
  try {
    response = await fetch(`https://${HOSTNAME}${path}`, {
      headers: {
        Accept: "application/json",
        "cf-access-token": accessToken,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    stop(`${codePrefix}_PUBLIC_${label}_READ`, `Access-authenticated ${label.toLowerCase()} request failed`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    stop(
      `${codePrefix}_PUBLIC_${label}_MEDIA_TYPE`,
      `Access-authenticated ${label.toLowerCase()} response must be application/json; got ${contentType || "missing content-type"}`,
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    stop(`${codePrefix}_PUBLIC_${label}_JSON`, `${label.toLowerCase()} response declared JSON but could not be parsed`);
  }
  return { response, body };
}

async function assertPrewriteHealthCanary(codePrefix, accessToken) {
  const { response, body } = await readAccessJson(codePrefix, "/api/health", accessToken, "HEALTH");
  if (
    response.status !== 200 ||
    body?.status !== "ok" ||
    body?.service !== WORKER_NAME ||
    body?.phase !== "phase-0"
  ) {
    stop(`${codePrefix}_HEALTH_CANARY`, "Access-authenticated current Worker health contract did not match");
  }
}

async function readPublicDashboard(codePrefix, accessToken) {
  const result = await readAccessJson(codePrefix, "/api/github/dashboard", accessToken, "DASHBOARD");
  if (!result.response.headers.get("cache-control")?.includes("no-store")) {
    stop(`${codePrefix}_PUBLIC_DASHBOARD_CACHE`, "dashboard response must remain no-store");
  }
  return result;
}

async function assertLivePublicCanary(codePrefix, accessToken) {
  const { response, body } = await readPublicDashboard(codePrefix, accessToken);
  if (response.status !== 200) stop(`${codePrefix}_LIVE_CANARY_STATUS`, `live dashboard returned HTTP ${response.status}`);
  if (typeof body?.generatedAt !== "string" || !Array.isArray(body?.projects) || !Array.isArray(body?.decisions)) {
    stop(`${codePrefix}_LIVE_CANARY_SHAPE`, "live dashboard did not return the normalized dashboard shape");
  }

  const repositories = body.projects.map((project) => project?.repository).sort();
  if (JSON.stringify(repositories) !== JSON.stringify(MANAGED_REPOSITORIES)) {
    stop(`${codePrefix}_LIVE_CANARY_REPOSITORIES`, "live dashboard repository set differs from the six managed repositories");
  }
  if (body.decisions.some((decision) => decision?.workflowState === "MERGE_READY")) {
    stop(`${codePrefix}_LIVE_CANARY_MERGE_READY`, "observational live dashboard must not emit MERGE_READY");
  }
  if (body.decisions.some((decision) => !Array.isArray(decision?.allowedActions) || decision.allowedActions.some((action) => action !== "OPEN_PR"))) {
    stop(`${codePrefix}_LIVE_CANARY_ACTIONS`, "live dashboard exposed an action other than OPEN_PR");
  }
}

async function apply(args) {
  assertBaseInputs(args.sha, args.ci);
  assertVersionId(args.currentVersion, "CURRENT_VERSION_ID_INVALID", "current version id");
  assertVersionId(args.currentDeployment, "CURRENT_DEPLOYMENT_ID_INVALID", "current deployment id");
  assertDomainId(args.domainId);

  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const accessToken = process.env.CONTROL_ACCESS_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";

  if (account !== ACCOUNT_ID) stop("ACCOUNT_ID_INVALID", "Cloudflare account does not match reviewed production account");
  if (!apiToken) stop("API_TOKEN_REQUIRED", "temporary rozkalns-control-setup Cloudflare API token is required");
  if (!accessToken) stop("ACCESS_TOKEN_REQUIRED", "short-lived Cloudflare Access user token is required for protected canaries");

  const expectedAuthorization =
    `${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${args.currentVersion} ` +
    `deployment ${args.currentDeployment} domain ${args.domainId}`;
  if (authorization !== expectedAuthorization) {
    stop("OWNER_AUTHORIZATION_INVALID", "live-read authorization must match exact main, CI and current Cloudflare state");
  }

  assertRepo(args.sha);
  await assertLiveSourceConfig();
  await assertCi(args.sha, args.ci);
  run("npm", ["run", "check"], { inherit: true, env: sanitizedChildEnvironment() });

  const beforeIds = versionIdSet(await listVersions(apiToken), "PREWRITE");
  await assertExpectedActive(apiToken, args.currentVersion, args.currentDeployment, false, "PREWRITE");
  await assertExactDomain(apiToken, args.domainId, "PREWRITE");
  await assertPrewriteHealthCanary("PREWRITE", accessToken);

  assertRepo(args.sha);
  await assertLiveSourceConfig();
  await assertCi(args.sha, args.ci);
  await assertExpectedActive(apiToken, args.currentVersion, args.currentDeployment, false, "FINAL_PREWRITE");
  await assertExactDomain(apiToken, args.domainId, "FINAL_PREWRITE");
  await assertPrewriteHealthCanary("FINAL_PREWRITE", accessToken);

  const finalBeforeIds = versionIdSet(await listVersions(apiToken), "FINAL_PREWRITE");
  if (beforeIds.size !== finalBeforeIds.size || [...beforeIds].some((id) => !finalBeforeIds.has(id))) {
    stop("FINAL_PREWRITE_VERSION_SET_CHANGED", "Worker version inventory changed during live-read preflight");
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
    { inherit: true, env: sanitizedChildEnvironment(apiToken) },
  );

  const afterVersions = await listVersions(apiToken);
  const newVersions = afterVersions.filter((version) => typeof version?.id === "string" && !beforeIds.has(version.id));
  if (newVersions.length !== 1) stop("POST_VERIFY_NEW_VERSION", "expected exactly one newly observed Worker version after deploy");
  const newVersionId = newVersions[0].id;

  const active = singleDeploymentVersion(await listDeployments(apiToken), "POST_VERIFY");
  if (active.versionId !== newVersionId) {
    stop("POST_VERIFY_ACTIVE_VERSION", "new live-read version is not receiving 100% of Worker deployment traffic");
  }
  if (active.deploymentId === args.currentDeployment) {
    stop("POST_VERIFY_DEPLOYMENT_ID", "deployment id did not change after live-read deploy");
  }

  assertVersionBindings(await versionDetail(apiToken, newVersionId), true, "POST_VERIFY");
  await assertSubdomainDisabled(apiToken, "POST_VERIFY");
  const domain = await assertExactDomain(apiToken, args.domainId, "POST_VERIFY");
  await assertLivePublicCanary("POST_VERIFY", accessToken);

  console.log("LIVE_READ_ENABLE_GATE=PASS");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log(`NEW_VERSION_ID=${newVersionId}`);
  console.log(`ACTIVE_DEPLOYMENT_ID=${active.deploymentId}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log(`CUSTOM_DOMAIN=${domain.hostname}`);
  console.log(`DOMAIN_ID=${domain.id}`);
  console.log("PUBLIC_UI_MODE=LIVE_READ_ONLY");
  console.log("CONTROL_LIVE_READ_ENABLED=TRUE");
  console.log("ACCESS_PROTECTION=PRESERVED");
  console.log("GITHUB_MUTATION=DISABLED");
  console.log("WEBHOOK_RUNTIME=DISABLED");
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
    console.error("UNEXPECTED_FAILURE: sanitized live-read enable gate failure");
    process.exitCode = 1;
  }
}
