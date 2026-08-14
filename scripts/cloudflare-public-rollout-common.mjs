import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeVersionItems } from "./cloudflare-bootstrap-response.mjs";

export const REPO = "rozkalnsandris/rozkalns-control-center";
export const ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
export const WORKER_NAME = "rozkalns-control";
export const ZONE_NAME = "rozkalns.net";
export const PUBLIC_HOSTNAME = "control.rozkalns.net";
export const BOOTSTRAP_VERSION_ID = "38819190-ab13-4865-8976-7b5f7d1c1966";
export const NON_DEPLOYED_VERSION_ID = "44fb14ab-b3d4-42eb-aebb-a2612332eef6";
export const BASELINE_DEPLOYMENT_ID = "ca152e0e-295c-47a0-8637-2cd146242e74";
export const PRIVATE_KEY_BINDING = "GITHUB_APP_PRIVATE_KEY_PEM";
export const D1_BINDING = "CONTROL_DB";
export const D1_DATABASE_ID = "8504e986-faf0-450c-bfb5-41b5dbf8be09";
export const LIVE_READS_BINDING = "CONTROL_GITHUB_LIVE_READS";
export const LIVE_READS_DISABLED = "disabled";
export const WRANGLER_VERSION = "4.120.0";
export const NODE_MINIMUM = "22.12.0";

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
    "CONTROL_OWNER_AUTHORIZATION",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

export function run(command, argv, { inherit = false, env = cleanEnv() } = {}) {
  const result = spawnSync(command, argv, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env,
  });
  if (result.error || result.status !== 0) {
    stop("COMMAND_FAILED", `${command} exited ${result.status ?? "unknown"}`);
  }
  return inherit ? "" : `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

export function wranglerPath() {
  return resolve("node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

export function assertBaseInputs(sha, ciRunId) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    stop("EXPECTED_SHA_INVALID", "expected SHA must be 40 lowercase hex characters");
  }
  if (!/^[1-9][0-9]*$/.test(ciRunId)) {
    stop("CI_RUN_ID_INVALID", "CI run id must be a positive integer");
  }
  const node = process.versions.node.split(".").map(Number);
  if (node[0] < 22 || (node[0] === 22 && node[1] < 12)) {
    stop("NODE_VERSION_INVALID", `Node ${NODE_MINIMUM}+ is required`);
  }
}

export function assertExactRepositoryState(sha) {
  if (run("git", ["branch", "--show-current"]) !== "main") {
    stop("BRANCH_NOT_MAIN", "apply requires branch main");
  }
  if (run("git", ["status", "--porcelain"]) !== "") {
    stop("WORKTREE_DIRTY", "apply requires a clean worktree");
  }
  if (run("git", ["rev-parse", "HEAD"]) !== sha) {
    stop("HEAD_MISMATCH", "local HEAD differs from authorized SHA");
  }
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]) !== sha) {
    stop("REMOTE_MAIN_MISMATCH", "origin/main moved from authorized SHA");
  }
}

export async function assertSourceFixtureConfig() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.engines?.node !== ">=22.12.0" || pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) {
    stop("TOOL_PIN_INVALID", "Node/Wrangler source pins changed");
  }

  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  if (config?.name !== WORKER_NAME) stop("WORKER_NAME_INVALID", "Wrangler Worker name changed");
  if (config?.workers_dev !== false) stop("WORKERS_DEV_NOT_DISABLED", "workers_dev must be explicitly false");
  if (config?.preview_urls !== false) stop("PREVIEW_URLS_NOT_DISABLED", "preview_urls must be explicitly false");
  for (const forbidden of ["route", "routes", "triggers", "custom_domain", "custom_domains"]) {
    if (Object.hasOwn(config, forbidden)) {
      stop("PUBLIC_ROUTE_CONFIG_PRESENT", `${forbidden} must remain absent before the guarded public rollout`);
    }
  }
  if (config?.vars?.[LIVE_READS_BINDING] !== LIVE_READS_DISABLED) {
    stop("LIVE_READS_NOT_DISABLED", "public fixture config must keep live GitHub reconciliation disabled");
  }

  const d1 = Array.isArray(config?.d1_databases) ? config.d1_databases : [];
  if (
    d1.length !== 1 ||
    d1[0]?.binding !== D1_BINDING ||
    d1[0]?.database_id !== D1_DATABASE_ID ||
    d1[0]?.database_name !== "rozkalns-control-production"
  ) {
    stop("D1_BINDING_INVALID", "production D1 source binding changed");
  }

  const requiredSecrets = config?.secrets?.required;
  if (!Array.isArray(requiredSecrets) || !requiredSecrets.includes(PRIVATE_KEY_BINDING)) {
    stop("PRIVATE_KEY_REQUIREMENT_INVALID", "GitHub App private-key secret must remain required");
  }

  const observedWrangler = run(wranglerPath(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (observedWrangler !== WRANGLER_VERSION) {
    stop("WRANGLER_VERSION_INVALID", "repository Wrangler version changed");
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

export async function assertExactMainCi(sha, runId) {
  const payload = await json(
    `${GH}/repos/${REPO}/actions/runs/${runId}`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "rozkalns-control-public-rollout" } },
    "CI_READ_FAILED",
  );
  if (
    payload?.name !== "CI" ||
    payload?.path !== ".github/workflows/ci.yml" ||
    payload?.head_branch !== "main" ||
    payload?.head_sha !== sha ||
    payload?.event !== "push" ||
    payload?.status !== "completed" ||
    payload?.conclusion !== "success"
  ) {
    stop("CI_GATE_INVALID", "run is not successful exact-main push CI");
  }
}

export async function cfGet(token, path) {
  const payload = await json(
    `${CF}/accounts/${ACCOUNT_ID}${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    "CLOUDFLARE_READ_FAILED",
  );
  if (payload?.success !== true) {
    stop("CLOUDFLARE_READ_INVALID", "Cloudflare read response was unsuccessful");
  }
  return payload.result;
}

export async function listVersions(token) {
  const result = normalizeVersionItems(
    await cfGet(token, `/workers/scripts/${WORKER_NAME}/versions?per_page=20`),
  );
  if (result === null) stop("VERSIONS_INVALID", "version-list result did not contain items");
  return result;
}

export async function listDeployments(token) {
  const result = await cfGet(token, `/workers/scripts/${WORKER_NAME}/deployments`);
  if (!Array.isArray(result?.deployments)) {
    stop("DEPLOYMENTS_INVALID", "deployment-list response did not contain deployments");
  }
  return result.deployments;
}

export async function assertSubdomainDisabled(token) {
  const result = await cfGet(token, `/workers/scripts/${WORKER_NAME}/subdomain`);
  if (result?.enabled !== false) stop("WORKERS_DEV_ENABLED", "workers.dev must remain disabled");
  if (result?.previews_enabled !== false) stop("PREVIEW_URLS_ENABLED", "Preview URLs must remain disabled");
}

export async function listDomains(token) {
  const result = await cfGet(token, "/workers/domains?per_page=100");
  if (!Array.isArray(result)) stop("DOMAINS_INVALID", "Worker domain inventory was not an array");
  return result;
}

export function assertNoPublicDomains(domains) {
  if (domains.some((domain) => domain?.hostname === PUBLIC_HOSTNAME)) {
    stop("TARGET_DOMAIN_ALREADY_PRESENT", `${PUBLIC_HOSTNAME} already exists in Worker domain inventory`);
  }
  if (domains.some((domain) => domain?.service === WORKER_NAME)) {
    stop("WORKER_DOMAIN_ALREADY_PRESENT", "Worker already has a Custom Domain");
  }
}

export function assertActiveDeployment(deployments, versionId, expectedDeploymentId = "") {
  if (deployments.length === 0) stop("ACTIVE_DEPLOYMENT_MISSING", "Worker has no active deployment evidence");
  const active = deployments[0];
  if (expectedDeploymentId && active?.id !== expectedDeploymentId) {
    stop("ACTIVE_DEPLOYMENT_ID_MISMATCH", "active deployment id changed from reviewed baseline");
  }
  const versions = active?.versions;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.version_id !== versionId ||
    versions[0]?.percentage !== 100
  ) {
    stop("ACTIVE_DEPLOYMENT_VERSION_MISMATCH", "active deployment is not 100% on the expected version");
  }
  return active;
}

export async function getVersionDetail(token, versionId) {
  return cfGet(token, `/workers/scripts/${WORKER_NAME}/versions/${versionId}`);
}

export function assertVersionBindings(versionDetail, { requireFixtureFlag = false } = {}) {
  const bindings = versionDetail?.resources?.bindings;
  if (!Array.isArray(bindings)) stop("VERSION_BINDINGS_INVALID", "version bindings were not available");

  const hasPrivateKey = bindings.some(
    (binding) =>
      binding?.name === PRIVATE_KEY_BINDING &&
      (binding?.type === "secret_text" || binding?.type === "secret_key"),
  );
  if (!hasPrivateKey) stop("PRIVATE_KEY_BINDING_MISSING", "deployed version is missing the GitHub App private-key binding");

  const hasD1 = bindings.some(
    (binding) =>
      binding?.name === D1_BINDING &&
      binding?.type === "d1" &&
      (binding?.database_id === D1_DATABASE_ID || binding?.id === D1_DATABASE_ID),
  );
  if (!hasD1) stop("D1_BINDING_MISSING", "deployed version is missing the reviewed production D1 binding");

  if (requireFixtureFlag) {
    const hasDisabledFlag = bindings.some(
      (binding) =>
        binding?.name === LIVE_READS_BINDING &&
        binding?.type === "plain_text" &&
        binding?.text === LIVE_READS_DISABLED,
    );
    if (!hasDisabledFlag) {
      stop("LIVE_READS_BINDING_NOT_DISABLED", "deployed version does not prove fixture-only GitHub read mode");
    }
  }
}

export async function assertReviewedBaseline(token) {
  const versions = await listVersions(token);
  const ids = versions.map((version) => version?.id).sort();
  const expected = [BOOTSTRAP_VERSION_ID, NON_DEPLOYED_VERSION_ID].sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    stop("VERSION_BASELINE_MISMATCH", "Worker version set changed from the reviewed two-version baseline");
  }

  const deployments = await listDeployments(token);
  assertActiveDeployment(deployments, BOOTSTRAP_VERSION_ID, BASELINE_DEPLOYMENT_ID);
  await assertSubdomainDisabled(token);
  assertNoPublicDomains(await listDomains(token));
  assertVersionBindings(await getVersionDetail(token, BOOTSTRAP_VERSION_ID));
}

export async function assertExactActiveFixtureVersion(token, expectedVersionId, { domainMustBeAbsent = true } = {}) {
  const versions = await listVersions(token);
  if (!versions.some((version) => version?.id === expectedVersionId)) {
    stop("EXPECTED_VERSION_MISSING", "expected Worker version is not present");
  }
  const deployments = await listDeployments(token);
  const active = assertActiveDeployment(deployments, expectedVersionId);
  await assertSubdomainDisabled(token);
  const domains = await listDomains(token);
  if (domainMustBeAbsent) assertNoPublicDomains(domains);
  assertVersionBindings(await getVersionDetail(token, expectedVersionId), { requireFixtureFlag: true });
  return { active, domains };
}
