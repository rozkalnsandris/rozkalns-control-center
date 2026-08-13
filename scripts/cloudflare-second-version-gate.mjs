#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeVersionItems } from "./cloudflare-bootstrap-response.mjs";

const WORKER_NAME = "rozkalns-control";
const SECRET_NAME = "GITHUB_APP_PRIVATE_KEY_PEM";
const BOOTSTRAP_VERSION_ID = "38819190-ab13-4865-8976-7b5f7d1c1966";
const AUTH_PREFIX = "authorize Phase 2 Cloudflare second non-deployed version upload ";
const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

function fail(code, message) {
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
  throw new Error(code);
}

function parseArgs(argv) {
  const args = { mode: "plan", expectedSha: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      args.mode = argv[++index] ?? "";
    } else if (arg === "--expected-sha") {
      args.expectedSha = argv[++index] ?? "";
    } else {
      fail("ARGUMENT_INVALID", `unsupported argument ${arg}`);
    }
  }
  if (args.mode !== "plan" && args.mode !== "apply") {
    fail("MODE_INVALID", "mode must be plan or apply");
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
  if (result.error) fail("COMMAND_FAILED", `${command} could not start`);
  if (result.status !== 0) fail("COMMAND_FAILED", `${command} exited ${result.status ?? "unknown"}`);
  return options.inherit ? "" : result.stdout.trim();
}

function sanitizedLocalEnvironment() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_READ_TOKEN;
  delete env.CLOUDFLARE_WRITE_TOKEN;
  delete env.CONTROL_OWNER_AUTHORIZATION;
  return env;
}

function childEnvironment(writeToken) {
  const env = sanitizedLocalEnvironment();
  env.CLOUDFLARE_API_TOKEN = writeToken;
  return env;
}

function repoWranglerPath() {
  return resolve("node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

function assertExactRepositoryState(expectedSha) {
  if (!SHA_PATTERN.test(expectedSha)) {
    fail("EXPECTED_SHA_INVALID", "expected SHA must be 40 lowercase hex characters");
  }
  const localEnv = sanitizedLocalEnvironment();
  const branch = run("git", ["branch", "--show-current"], { env: localEnv });
  if (branch !== "main") fail("BRANCH_NOT_MAIN", "apply requires branch main");
  if (run("git", ["status", "--porcelain"], { env: localEnv }) !== "") {
    fail("WORKTREE_DIRTY", "apply requires a clean worktree");
  }
  const head = run("git", ["rev-parse", "HEAD"], { env: localEnv });
  if (head !== expectedSha) fail("HEAD_MISMATCH", "local HEAD does not match expected SHA");
  run("git", ["fetch", "--quiet", "origin", "main"], { env: localEnv });
  const remoteMain = run("git", ["rev-parse", "origin/main"], { env: localEnv });
  if (remoteMain !== expectedSha) fail("REMOTE_MAIN_MISMATCH", "origin/main moved from the authorized SHA");
}

async function assertNonRoutableConfig() {
  let config;
  try {
    config = JSON.parse(await readFile(resolve("wrangler.jsonc"), "utf8"));
  } catch {
    fail("WRANGLER_CONFIG_INVALID", "wrangler.jsonc must be valid JSON for guarded upload");
  }
  if (config?.name !== WORKER_NAME) {
    fail("WRANGLER_NAME_INVALID", "Wrangler Worker name does not match the guarded target");
  }
  if (config?.workers_dev !== false) {
    fail("WORKERS_DEV_NOT_DISABLED", "workers_dev must be explicitly false before version upload");
  }
  if (config?.preview_urls !== false) {
    fail("PREVIEW_URLS_NOT_DISABLED", "preview_urls must be explicitly false before version upload");
  }
  for (const forbidden of ["route", "routes", "triggers", "custom_domain", "custom_domains"]) {
    if (Object.hasOwn(config, forbidden)) {
      fail("PUBLIC_TRIGGER_CONFIG_PRESENT", `${forbidden} is forbidden during guarded version upload`);
    }
  }
}

async function cloudflareGet(accountId, token, path) {
  const response = await fetch(`${API_ORIGIN}/accounts/${accountId}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) fail("CLOUDFLARE_READ_FAILED", `read-only verification HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.success !== true) fail("CLOUDFLARE_READ_INVALID", "read-only verification response was not successful");
  return payload.result;
}

async function listScripts(accountId, token) {
  const result = await cloudflareGet(accountId, token, "/workers/scripts?per_page=100");
  if (!Array.isArray(result)) fail("CLOUDFLARE_READ_INVALID", "script inventory response was not usable");
  return result.map((entry) => entry?.id).filter((value) => typeof value === "string");
}

function normalizeDeployments(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.deployments)) return result.deployments;
  fail("DEPLOYMENTS_INVALID", "deployment response was not usable");
}

function privateKeyBindingPresent(versionDetail) {
  const bindings = versionDetail?.resources?.bindings;
  if (!Array.isArray(bindings)) return false;
  return bindings.some(
    (binding) =>
      binding?.name === SECRET_NAME &&
      (binding?.type === "secret_text" || binding?.type === "secret_key"),
  );
}

function assertSingleBootstrapDeployment(deployments, codePrefix) {
  if (deployments.length !== 1) {
    fail(`${codePrefix}_DEPLOYMENT_COUNT`, "expected exactly one active deployment");
  }
  const deployment = deployments[0];
  if (typeof deployment?.id !== "string" || deployment.id.length === 0) {
    fail(`${codePrefix}_DEPLOYMENT_ID`, "active deployment did not contain an id");
  }
  const versions = deployment?.versions;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.version_id !== BOOTSTRAP_VERSION_ID ||
    versions[0]?.percentage !== 100
  ) {
    fail(`${codePrefix}_DEPLOYMENT_VERSION`, "active deployment must remain 100% on the bootstrap version");
  }
  return deployment.id;
}

async function assertSubdomainDisabled(accountId, token, codePrefix) {
  const subdomain = await cloudflareGet(accountId, token, `/workers/scripts/${WORKER_NAME}/subdomain`);
  if (subdomain?.enabled !== false) {
    fail(`${codePrefix}_WORKERS_DEV_ENABLED`, "workers.dev must remain disabled");
  }
  if (subdomain?.previews_enabled !== false) {
    fail(`${codePrefix}_PREVIEW_URLS_ENABLED`, "preview URLs must remain disabled");
  }
}

function printPlan() {
  console.log("MODE=PLAN");
  console.log(`WORKER=${WORKER_NAME}`);
  console.log(`EXPECTED_BOOTSTRAP_VERSION=${BOOTSTRAP_VERSION_ID}`);
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("AUTHORIZED_APPLY_UPLOADS_SECOND_VERSION=YES");
  console.log("TRAFFIC_DEPLOYMENT=NO");
  console.log("PUBLIC_ROUTING_CHANGE=NO");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("LOCAL_PRIVATE_KEY_REQUIRED=NO");
  console.log("APPLY_REQUIRES=exact-main+clean-tree+read-token+write-token+exact-live-baseline+owner-authorization");
  console.log(`OWNER_AUTHORIZATION_FORMAT=${AUTH_PREFIX}<exact-main-sha>`);
}

async function apply(args) {
  const expectedSha = args.expectedSha;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const readToken = process.env.CLOUDFLARE_READ_TOKEN ?? "";
  const writeToken = process.env.CLOUDFLARE_WRITE_TOKEN ?? "";
  const ownerAuthorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";

  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    fail("ACCOUNT_ID_INVALID", "CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex characters");
  }
  if (!readToken) fail("READ_TOKEN_REQUIRED", "CLOUDFLARE_READ_TOKEN is required");
  if (!writeToken) fail("WRITE_TOKEN_REQUIRED", "CLOUDFLARE_WRITE_TOKEN is required");
  if (readToken === writeToken) fail("TOKEN_SEPARATION_REQUIRED", "read and write tokens must be distinct");
  if (ownerAuthorization !== `${AUTH_PREFIX}${expectedSha}`) {
    fail("OWNER_AUTHORIZATION_INVALID", "one-shot owner authorization does not match the expected SHA");
  }

  assertExactRepositoryState(expectedSha);
  await assertNonRoutableConfig();
  const localEnv = sanitizedLocalEnvironment();
  const wrangler = repoWranglerPath();
  run(wrangler, ["--version"], { env: localEnv });
  run("npm", ["run", "check"], { inherit: true, env: localEnv });

  const scripts = await listScripts(accountId, readToken);
  if (!scripts.includes(WORKER_NAME)) {
    fail("TARGET_MISSING", "second-version gate requires the existing Worker");
  }

  const beforeVersionsPage = await cloudflareGet(
    accountId,
    readToken,
    `/workers/scripts/${WORKER_NAME}/versions?per_page=20`,
  );
  const beforeVersions = normalizeVersionItems(beforeVersionsPage);
  if (beforeVersions === null) {
    fail("PREWRITE_VERSIONS_INVALID", "version-list response did not contain a paginated items array");
  }
  if (
    beforeVersions.length !== 1 ||
    beforeVersions[0]?.id !== BOOTSTRAP_VERSION_ID
  ) {
    fail("PREWRITE_VERSION_BASELINE", "expected exactly the known bootstrap version before upload");
  }

  const beforeDeployments = normalizeDeployments(
    await cloudflareGet(accountId, readToken, `/workers/scripts/${WORKER_NAME}/deployments`),
  );
  const beforeDeploymentId = assertSingleBootstrapDeployment(beforeDeployments, "PREWRITE");
  await assertSubdomainDisabled(accountId, readToken, "PREWRITE");

  const bootstrapDetail = await cloudflareGet(
    accountId,
    readToken,
    `/workers/scripts/${WORKER_NAME}/versions/${BOOTSTRAP_VERSION_ID}`,
  );
  if (!privateKeyBindingPresent(bootstrapDetail)) {
    fail("PREWRITE_PRIVATE_KEY_BINDING", "bootstrap version is missing the required GitHub App private-key binding");
  }

  let uploadSucceeded = false;
  const result = spawnSync(
    wrangler,
    [
      "versions",
      "upload",
      "--name",
      WORKER_NAME,
      "--strict",
      "--experimental-provision=false",
      "--experimental-auto-create=false",
      "--install-skills=false",
    ],
    { cwd: process.cwd(), stdio: "inherit", env: childEnvironment(writeToken) },
  );
  if (result.error || result.status !== 0) {
    fail("VERSION_UPLOAD_FAILED", "Wrangler second-version upload failed");
  }
  uploadSucceeded = true;

  try {
    await delay(2000);

    const afterVersionsPage = await cloudflareGet(
      accountId,
      readToken,
      `/workers/scripts/${WORKER_NAME}/versions?per_page=20`,
    );
    const afterVersions = normalizeVersionItems(afterVersionsPage);
    if (afterVersions === null) {
      fail("POST_VERIFY_VERSIONS_INVALID", "version-list response did not contain a paginated items array");
    }
    if (afterVersions.length !== 2) {
      fail("POST_VERIFY_VERSION_COUNT", "expected exactly two Worker versions after upload");
    }
    const bootstrapMatches = afterVersions.filter((version) => version?.id === BOOTSTRAP_VERSION_ID);
    const newVersions = afterVersions.filter((version) => version?.id !== BOOTSTRAP_VERSION_ID);
    if (bootstrapMatches.length !== 1 || newVersions.length !== 1) {
      fail("POST_VERIFY_VERSION_SET", "expected exactly one bootstrap version and one new version");
    }
    const newVersionId = newVersions[0]?.id;
    if (typeof newVersionId !== "string" || newVersionId.length === 0) {
      fail("POST_VERIFY_NEW_VERSION_ID", "new Worker version did not contain an id");
    }

    const afterDeployments = normalizeDeployments(
      await cloudflareGet(accountId, readToken, `/workers/scripts/${WORKER_NAME}/deployments`),
    );
    const afterDeploymentId = assertSingleBootstrapDeployment(afterDeployments, "POST_VERIFY");
    if (afterDeploymentId !== beforeDeploymentId) {
      fail("POST_VERIFY_DEPLOYMENT_CHANGED", "active deployment id changed during non-deployed version upload");
    }

    await assertSubdomainDisabled(accountId, readToken, "POST_VERIFY");

    const newVersionDetail = await cloudflareGet(
      accountId,
      readToken,
      `/workers/scripts/${WORKER_NAME}/versions/${newVersionId}`,
    );
    if (!privateKeyBindingPresent(newVersionDetail)) {
      fail("POST_VERIFY_PRIVATE_KEY_BINDING", "new version did not preserve the required GitHub App private-key binding");
    }

    console.log("APPLY=PASS");
    console.log(`WORKER=${WORKER_NAME}`);
    console.log(`BASE_VERSION_ID=${BOOTSTRAP_VERSION_ID}`);
    console.log(`NEW_VERSION_ID=${newVersionId}`);
    console.log("VERSION_COUNT=2");
    console.log(`ACTIVE_DEPLOYMENT_ID=${afterDeploymentId}`);
    console.log("ACTIVE_DEPLOYMENTS=1");
    console.log(`ACTIVE_TRAFFIC_VERSION_ID=${BOOTSTRAP_VERSION_ID}`);
    console.log("ACTIVE_TRAFFIC_PERCENT=100");
    console.log("DEPLOYMENT_UNCHANGED=YES");
    console.log("TRAFFIC_DEPLOYMENT=NO");
    console.log("WORKERS_DEV=DISABLED");
    console.log("PREVIEW_URLS=DISABLED");
    console.log("PUBLIC_ROUTING_CHANGE=NO");
    console.log("PRIVATE_KEY_BINDING=PROVEN_ON_NEW_VERSION");
  } catch (error) {
    if (uploadSucceeded) console.error("POST_UPLOAD_STATE=REVIEW_REQUIRED");
    throw error;
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") printPlan();
  else await apply(args);
} catch {
  if (process.exitCode !== 1) {
    console.error("UNEXPECTED_FAILURE: sanitized controller failure");
    process.exitCode = 1;
  }
}
