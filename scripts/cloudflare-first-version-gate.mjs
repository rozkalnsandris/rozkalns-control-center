#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const WORKER_NAME = "rozkalns-control";
const SECRET_NAME = "GITHUB_APP_PRIVATE_KEY_PEM";
const AUTH_PREFIX = "authorize Phase 2 Cloudflare first non-deployed version ";
const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const PRIVATE_KEY_BEGIN = "-----BEGIN " + "PRIVATE KEY-----";
const RSA_PRIVATE_KEY_BEGIN = "-----BEGIN RSA " + "PRIVATE KEY-----";

function fail(code, message) {
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
  throw new Error(code);
}

function parseArgs(argv) {
  const args = { mode: "plan", expectedSha: "", privateKeyFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      args.mode = argv[++index] ?? "";
    } else if (arg === "--expected-sha") {
      args.expectedSha = argv[++index] ?? "";
    } else if (arg === "--private-key-file") {
      args.privateKeyFile = argv[++index] ?? "";
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

async function validatePrivateKeyFile(path) {
  if (!path) fail("PRIVATE_KEY_FILE_REQUIRED", "apply requires --private-key-file");
  const resolved = resolve(path);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) fail("PRIVATE_KEY_FILE_INVALID", "private key path must be a regular file");
  if ((metadata.mode & 0o077) !== 0) {
    fail("PRIVATE_KEY_FILE_PERMISSIONS", "private key file must not be group/world accessible");
  }
  const pem = await readFile(resolved, "utf8");
  if (!pem.includes(PRIVATE_KEY_BEGIN) && !pem.includes(RSA_PRIVATE_KEY_BEGIN)) {
    fail("PRIVATE_KEY_FILE_INVALID", "private key file is not a supported PEM private key");
  }
  return pem;
}

function normalizeDeployments(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.deployments)) return result.deployments;
  fail("POST_VERIFY_DEPLOYMENTS_INVALID", "deployment response was not usable");
}

function printPlan() {
  console.log("MODE=PLAN");
  console.log(`WORKER=${WORKER_NAME}`);
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("TRAFFIC_DEPLOYMENT=NO");
  console.log("APPLY_REQUIRES=exact-main+clean-tree+read-token+write-token+private-key-file+owner-authorization");
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
  const localEnv = sanitizedLocalEnvironment();
  const wrangler = repoWranglerPath();
  run(wrangler, ["--version"], { env: localEnv });
  run("npm", ["run", "check"], { inherit: true, env: localEnv });

  const before = await listScripts(accountId, readToken);
  if (before.includes(WORKER_NAME)) {
    fail("TARGET_ALREADY_EXISTS", "first-version gate requires target Worker to be absent");
  }

  const pem = await validatePrivateKeyFile(args.privateKeyFile);
  const tempRoot = await mkdtemp(join(tmpdir(), "rozkalns-control-first-version-"));
  const secretFile = join(tempRoot, "secrets.json");
  let uploadSucceeded = false;

  try {
    await writeFile(secretFile, JSON.stringify({ [SECRET_NAME]: pem }), { encoding: "utf8", mode: 0o600 });
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
        "--secrets-file",
        secretFile,
        "--message",
        `Phase 2 first non-deployed version ${expectedSha}`,
        "--tag",
        `phase2-bootstrap-${expectedSha.slice(0, 12)}`,
      ],
      { cwd: process.cwd(), stdio: "inherit", env: childEnvironment(writeToken) },
    );
    if (result.error || result.status !== 0) {
      fail("VERSION_UPLOAD_FAILED", "Wrangler version upload failed");
    }
    uploadSucceeded = true;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  try {
    await delay(2000);
    const after = await listScripts(accountId, readToken);
    if (!after.includes(WORKER_NAME)) {
      fail("POST_VERIFY_WORKER_MISSING", "uploaded Worker is not visible to read-only verification");
    }

    const versions = await cloudflareGet(accountId, readToken, `/workers/scripts/${WORKER_NAME}/versions?per_page=20`);
    if (!Array.isArray(versions) || versions.length !== 1 || typeof versions[0]?.id !== "string") {
      fail("POST_VERIFY_VERSION_COUNT", "expected exactly one first Worker version");
    }

    const deployments = normalizeDeployments(
      await cloudflareGet(accountId, readToken, `/workers/scripts/${WORKER_NAME}/deployments`),
    );
    if (deployments.length !== 0) {
      fail("POST_VERIFY_DEPLOYMENT_PRESENT", "unexpected active deployment exists");
    }

    console.log("APPLY=PASS");
    console.log(`WORKER=${WORKER_NAME}`);
    console.log(`VERSION_ID=${versions[0].id}`);
    console.log("ACTIVE_DEPLOYMENTS=0");
    console.log("TRAFFIC_DEPLOYMENT=NO");
    console.log("LOCAL_TEMP_SECRET_FILE_REMOVED=YES");
  } catch (error) {
    if (uploadSucceeded) console.error("POST_UPLOAD_STATE=REVIEW_REQUIRED");
    throw error;
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") printPlan();
  else await apply(args);
} catch (error) {
  if (process.exitCode !== 1) {
    console.error("UNEXPECTED_FAILURE: sanitized controller failure");
    process.exitCode = 1;
  }
}
