import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeVersionItems } from "./cloudflare-bootstrap-response.mjs";

export const REPO = "rozkalnsandris/rozkalns-control-center";
export const WORKER_NAME = "rozkalns-control";
export const ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
export const DB_NAME = "rozkalns-control-production";
export const DB_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
export const SECRET_NAME = "GITHUB_APP_PRIVATE_KEY_PEM";
export const HOSTNAME = "control.rozkalns.net";
export const ZONE_NAME = "rozkalns.net";
export const BOOTSTRAP_VERSION_ID = "38819190-ab13-4865-8976-7b5f7d1c1966";
export const SECOND_VERSION_ID = "44fb14ab-b3d4-42eb-aebb-a2612332eef6";
export const BASE_DEPLOYMENT_ID = "ca152e0e-295c-47a0-8637-2cd146242e74";
export const WRANGLER_VERSION = "4.120.0";

const CF = "https://api.cloudflare.com/client/v4";
const GH = "https://api.github.com";

export function stop(code, message) {
  console.error(`STOP=${code}`);
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
  throw new Error(code);
}

export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_READ_TOKEN",
    "CLOUDFLARE_WRITE_TOKEN",
    "CONTROL_OWNER_AUTHORIZATION",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

export function childEnvironment(writeToken) {
  return cleanEnv({ CLOUDFLARE_API_TOKEN: writeToken });
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: options.env ?? cleanEnv(),
  });
  if (result.error || result.status !== 0) {
    stop("COMMAND_FAILED", `${command} exited ${result.status ?? "unknown"}`);
  }
  return options.inherit ? "" : `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

export function wranglerPath() {
  return resolve("node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

export function assertBaseInputs(expectedSha, expectedCiRunId) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    stop("EXPECTED_SHA_INVALID", "expected SHA must be 40 lowercase hex characters");
  }
  if (!/^[1-9][0-9]*$/.test(expectedCiRunId)) {
    stop("CI_RUN_ID_INVALID", "CI run id must be a positive integer");
  }
}

export function assertRepo(expectedSha) {
  if (run("git", ["branch", "--show-current"]) !== "main") {
    stop("BRANCH_NOT_MAIN", "apply requires branch main");
  }
  if (run("git", ["status", "--porcelain"]) !== "") {
    stop("WORKTREE_DIRTY", "apply requires a clean worktree");
  }
  if (run("git", ["rev-parse", "HEAD"]) !== expectedSha) {
    stop("HEAD_MISMATCH", "local HEAD does not match authorized SHA");
  }
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== expectedSha) {
    stop("REMOTE_MAIN_MISMATCH", "origin/main moved from authorized SHA");
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

export async function assertCi(expectedSha, expectedCiRunId) {
  const payload = await json(
    `${GH}/repos/${REPO}/actions/runs/${expectedCiRunId}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "rozkalns-control-ui-rollout-gate",
      },
    },
    "CI_READ_FAILED",
  );
  if (
    payload?.name !== "CI" ||
    payload?.path !== ".github/workflows/ci.yml" ||
    payload?.head_branch !== "main" ||
    payload?.head_sha !== expectedSha ||
    payload?.event !== "push" ||
    payload?.status !== "completed" ||
    payload?.conclusion !== "success"
  ) {
    stop("CI_GATE_INVALID", "run is not successful exact-main push CI");
  }
}

export async function assertFixtureSourceConfig() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) {
    stop("WRANGLER_PIN_INVALID", "repository Wrangler pin changed");
  }

  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  if (config?.name !== WORKER_NAME) stop("WORKER_NAME_INVALID", "Worker target changed");
  if (config?.workers_dev !== false) stop("WORKERS_DEV_NOT_DISABLED", "workers.dev must remain disabled");
  if (config?.preview_urls !== false) stop("PREVIEW_URLS_NOT_DISABLED", "Preview URLs must remain disabled");
  if (config?.vars?.CONTROL_LIVE_READ_ENABLED !== "false") {
    stop("LIVE_READ_NOT_DISABLED", "first public UI rollout requires CONTROL_LIVE_READ_ENABLED=false");
  }
  if (config?.assets?.directory !== "./dist/client" || config?.assets?.not_found_handling !== "single-page-application") {
    stop("ASSETS_CONFIG_INVALID", "reviewed SPA Static Assets configuration changed");
  }
  for (const forbidden of ["route", "routes", "triggers", "custom_domain", "custom_domains"]) {
    if (Object.hasOwn(config, forbidden)) stop("SOURCE_ROUTING_PRESENT", `${forbidden} is forbidden in the first UI rollout source config`);
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

export async function cfGet(token, path) {
  const payload = await json(
    `${CF}/accounts/${ACCOUNT_ID}${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    "CLOUDFLARE_READ_FAILED",
  );
  if (payload?.success !== true) stop("CLOUDFLARE_READ_INVALID", "Cloudflare read response was unsuccessful");
  return payload.result;
}

export async function cfWrite(writeToken, path, method, body) {
  const payload = await json(
    `${CF}/accounts/${ACCOUNT_ID}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${writeToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    "CLOUDFLARE_WRITE_FAILED",
  );
  if (payload?.success !== true) stop("CLOUDFLARE_WRITE_INVALID", "Cloudflare write response was unsuccessful");
  return payload.result;
}

export async function listVersions(readToken) {
  const page = await cfGet(readToken, `/workers/scripts/${WORKER_NAME}/versions?per_page=20`);
  const versions = normalizeVersionItems(page);
  if (versions === null) stop("VERSIONS_INVALID", "version list did not contain a paginated items array");
  return versions;
}

export function normalizeDeployments(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.deployments)) return result.deployments;
  stop("DEPLOYMENTS_INVALID", "deployment response was not usable");
}

export async function listDeployments(readToken) {
  return normalizeDeployments(await cfGet(readToken, `/workers/scripts/${WORKER_NAME}/deployments`));
}

export function singleDeploymentVersion(deployments, codePrefix) {
  if (deployments.length !== 1) stop(`${codePrefix}_DEPLOYMENT_COUNT`, "expected exactly one active deployment");
  const deployment = deployments[0];
  if (typeof deployment?.id !== "string" || deployment.id.length === 0) {
    stop(`${codePrefix}_DEPLOYMENT_ID`, "deployment id missing");
  }
  const versions = deployment?.versions;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    typeof versions[0]?.version_id !== "string" ||
    versions[0]?.percentage !== 100
  ) {
    stop(`${codePrefix}_DEPLOYMENT_VERSION`, "deployment must route 100% to exactly one version");
  }
  return { deploymentId: deployment.id, versionId: versions[0].version_id };
}

export async function assertSubdomainDisabled(readToken, codePrefix) {
  const subdomain = await cfGet(readToken, `/workers/scripts/${WORKER_NAME}/subdomain`);
  if (subdomain?.enabled !== false) stop(`${codePrefix}_WORKERS_DEV_ENABLED`, "workers.dev must remain disabled");
  if (subdomain?.previews_enabled !== false) stop(`${codePrefix}_PREVIEW_URLS_ENABLED`, "Preview URLs must remain disabled");
}

export async function listDomains(readToken) {
  const domains = await cfGet(readToken, `/workers/domains?service=${encodeURIComponent(WORKER_NAME)}`);
  if (!Array.isArray(domains)) stop("DOMAINS_INVALID", "Workers domain inventory was not an array");
  return domains;
}

export function assertNoWorkerDomains(domains, codePrefix) {
  if (domains.length !== 0) stop(`${codePrefix}_DOMAIN_PRESENT`, "Worker must have no Custom Domain before first public attach");
}

export async function versionDetail(readToken, versionId) {
  return cfGet(readToken, `/workers/scripts/${WORKER_NAME}/versions/${encodeURIComponent(versionId)}`);
}

export function assertRequiredBindings(detail, codePrefix) {
  const bindings = detail?.resources?.bindings;
  if (!Array.isArray(bindings)) stop(`${codePrefix}_BINDINGS_INVALID`, "version bindings were not available");

  const secret = bindings.find(
    (binding) =>
      binding?.name === SECRET_NAME &&
      (binding?.type === "secret_text" || binding?.type === "secret_key"),
  );
  if (!secret) stop(`${codePrefix}_PRIVATE_KEY_BINDING`, "required GitHub App private-key binding is missing");

  const d1 = bindings.find(
    (binding) =>
      binding?.name === "CONTROL_DB" &&
      binding?.type === "d1" &&
      (binding?.database_id === DB_ID || binding?.id === DB_ID),
  );
  if (!d1) stop(`${codePrefix}_D1_BINDING`, "required production D1 binding is missing or mismatched");
}

export function assertHistoricalPreDeployBaseline(versions, deployments) {
  const ids = versions.map((version) => version?.id).sort();
  const expected = [BOOTSTRAP_VERSION_ID, SECOND_VERSION_ID].sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    stop("PREWRITE_VERSION_BASELINE", "expected exactly the two previously proven Worker versions");
  }
  const current = singleDeploymentVersion(deployments, "PREWRITE");
  if (current.deploymentId !== BASE_DEPLOYMENT_ID || current.versionId !== BOOTSTRAP_VERSION_ID) {
    stop("PREWRITE_DEPLOYMENT_BASELINE", "active deployment differs from the previously proven bootstrap baseline");
  }
  return current;
}
