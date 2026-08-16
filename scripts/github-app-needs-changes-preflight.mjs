#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { sign as signRsaSha256 } from "node:crypto";
import os from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PREFLIGHT_CONTRACT = Object.freeze({
  apiOrigin: "https://api.github.com",
  apiVersion: "2026-03-10",
  accept: "application/vnd.github+json",
  userAgent: "Rozkalns-Control-Needs-Changes-Preflight",
  appId: 4567356,
  appName: "Rozkalns Control",
  clientId: "Iv23likDoFtVeWBJfdFS",
  installationId: 153121564,
  owner: "rozkalnsandris",
  managedRepositories: Object.freeze([
    "hermes-tech",
    "hermes-deals",
    "rozkalns-cv",
    "RPi5_main",
    "ops-workflows",
    "rozkalnsandris",
  ]),
  excludedRepository: "hermes-email-skill",
  currentPermissions: Object.freeze({
    actions: "read",
    checks: "read",
    contents: "read",
    issues: "read",
    metadata: "read",
    pull_requests: "read",
  }),
  proposedPermissionDelta: "pull_requests:read->write",
});

const MAX_RESPONSE_BYTES = 256 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

export class GitHubAppNeedsChangesPreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = "GitHubAppNeedsChangesPreflightError";
    this.code = code;
  }
}

function fail(code) {
  throw new GitHubAppNeedsChangesPreflightError(code);
}

function failUnexpectedStatus(stage, status) {
  fail(`UNEXPECTED_STATUS:${stage}:${status}`);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function stableEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MALFORMED_RESPONSE");
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

function exactObject(actual, expected, code) {
  const actualEntries = stableEntries(actual);
  const expectedEntries = stableEntries(expected);
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) fail(code);
}

function exactString(value, expected, code) {
  if (value !== expected) fail(code);
}

function exactInteger(value, expected, code) {
  if (!Number.isSafeInteger(value) || value !== expected) fail(code);
}

function exactNullableNull(value, code) {
  if (value !== null) fail(code);
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MALFORMED_RESPONSE");
  return value;
}

function normalizeRepositoryFullName(value) {
  if (typeof value !== "string" || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(value)) {
    fail("MALFORMED_RESPONSE");
  }
  return value.toLowerCase();
}

function normalizePermissions(value, code = "PERMISSION_DRIFT") {
  const permissions = record(value);
  exactObject(permissions, PREFLIGHT_CONTRACT.currentPermissions, code);
  return permissions;
}

export function createGitHubAppJwt(privateKeyPem, nowMs = Date.now()) {
  if (typeof privateKeyPem !== "string" || privateKeyPem.trim() === "") fail("PRIVATE_KEY_UNAVAILABLE");
  if (!Number.isFinite(nowMs)) fail("INVALID_CLOCK");

  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: PREFLIGHT_CONTRACT.clientId,
    }),
  );
  const signingInput = `${header}.${payload}`;

  let signature;
  try {
    signature = signRsaSha256("RSA-SHA256", Buffer.from(signingInput), privateKeyPem);
  } catch {
    fail("JWT_SIGNING_FAILED");
  }
  if (!signature || signature.byteLength === 0) fail("JWT_SIGNING_FAILED");
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

function buildHeaders(authorization, hasBody = false) {
  const headers = new Headers({
    Accept: PREFLIGHT_CONTRACT.accept,
    Authorization: `Bearer ${authorization}`,
    "User-Agent": PREFLIGHT_CONTRACT.userAgent,
    "X-GitHub-Api-Version": PREFLIGHT_CONTRACT.apiVersion,
  });
  if (hasBody) headers.set("Content-Type", "application/json");
  return headers;
}

async function readJsonResponse(response, expectedStatus, stage) {
  if (!(response instanceof Response)) fail("TRANSPORT_FAILED");
  if (response.status !== expectedStatus) failUnexpectedStatus(stage, response.status);
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) fail("MALFORMED_RESPONSE");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) fail("RESPONSE_TOO_LARGE");
  try {
    return JSON.parse(text);
  } catch {
    fail("MALFORMED_RESPONSE");
  }
}

async function apiRequest(fetchImpl, { method, path, authorization, body, expectedStatus, stage }) {
  if (typeof fetchImpl !== "function") fail("TRANSPORT_FAILED");
  if (!path.startsWith("/")) fail("INVALID_ENDPOINT");
  const url = new URL(path, PREFLIGHT_CONTRACT.apiOrigin);
  if (url.origin !== PREFLIGHT_CONTRACT.apiOrigin) fail("INVALID_ENDPOINT");

  const request = new Request(url, {
    method,
    headers: buildHeaders(authorization, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

  let response;
  try {
    response = await fetchImpl(request);
  } catch {
    fail("TRANSPORT_FAILED");
  }
  return readJsonResponse(response, expectedStatus, stage);
}

async function expectNotInstalled(fetchImpl, repository, jwt) {
  const path = `/repos/${PREFLIGHT_CONTRACT.owner}/${repository}/installation`;
  const request = new Request(new URL(path, PREFLIGHT_CONTRACT.apiOrigin), {
    method: "GET",
    headers: buildHeaders(jwt),
    redirect: "manual",
  });

  let response;
  try {
    response = await fetchImpl(request);
  } catch {
    fail("TRANSPORT_FAILED");
  }
  if (!(response instanceof Response)) fail("TRANSPORT_FAILED");
  if (response.status === 404) return;
  if (response.status === 200) fail("EXCLUDED_REPOSITORY_INSTALLED");
  failUnexpectedStatus("EXCLUDED_REPOSITORY_INSTALLATION", response.status);
}

function assertApp(app) {
  const value = record(app);
  exactInteger(value.id, PREFLIGHT_CONTRACT.appId, "APP_ID_DRIFT");
  exactString(value.client_id, PREFLIGHT_CONTRACT.clientId, "CLIENT_ID_DRIFT");
  exactString(value.name, PREFLIGHT_CONTRACT.appName, "APP_NAME_DRIFT");
  normalizePermissions(value.permissions, "APP_PERMISSION_DRIFT");
}

function assertInstallation(installation) {
  const value = record(installation);
  exactInteger(value.id, PREFLIGHT_CONTRACT.installationId, "INSTALLATION_ID_DRIFT");
  exactInteger(value.app_id, PREFLIGHT_CONTRACT.appId, "APP_ID_DRIFT");
  if (value.client_id !== undefined) exactString(value.client_id, PREFLIGHT_CONTRACT.clientId, "CLIENT_ID_DRIFT");
  exactString(record(value.account).login, PREFLIGHT_CONTRACT.owner, "INSTALLATION_OWNER_DRIFT");
  exactString(value.repository_selection, "selected", "REPOSITORY_SELECTION_DRIFT");
  exactNullableNull(value.suspended_at, "INSTALLATION_SUSPENDED");
  normalizePermissions(value.permissions);
}

function assertRepositoryInstallation(installation) {
  assertInstallation(installation);
}

function assertInventory(payload) {
  const value = record(payload);
  exactInteger(value.total_count, PREFLIGHT_CONTRACT.managedRepositories.length, "REPOSITORY_COUNT_DRIFT");
  if (!Array.isArray(value.repositories)) fail("MALFORMED_RESPONSE");
  const actual = value.repositories.map((repository) => normalizeRepositoryFullName(record(repository).full_name)).sort();
  const expected = PREFLIGHT_CONTRACT.managedRepositories
    .map((repository) => `${PREFLIGHT_CONTRACT.owner}/${repository}`.toLowerCase())
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("REPOSITORY_SET_DRIFT");
}

function assertReadOnlyInventoryToken(tokenResponse) {
  const value = record(tokenResponse);
  if (typeof value.token !== "string" || value.token.length < 8) fail("READ_TOKEN_UNAVAILABLE");
  exactObject(value.permissions, { metadata: "read" }, "READ_TOKEN_SCOPE_DRIFT");
  if (typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at))) {
    fail("READ_TOKEN_EXPIRY_INVALID");
  }
  return value.token;
}

export async function observeGitHubAppState({ fetchImpl = fetch, privateKeyPem, nowMs = Date.now() } = {}) {
  const jwt = createGitHubAppJwt(privateKeyPem, nowMs);

  const app = await apiRequest(fetchImpl, {
    method: "GET",
    path: "/app",
    authorization: jwt,
    expectedStatus: 200,
    stage: "APP",
  });
  assertApp(app);

  const installation = await apiRequest(fetchImpl, {
    method: "GET",
    path: `/app/installations/${PREFLIGHT_CONTRACT.installationId}`,
    authorization: jwt,
    expectedStatus: 200,
    stage: "INSTALLATION",
  });
  assertInstallation(installation);

  for (const repository of PREFLIGHT_CONTRACT.managedRepositories) {
    const repositoryInstallation = await apiRequest(fetchImpl, {
      method: "GET",
      path: `/repos/${PREFLIGHT_CONTRACT.owner}/${repository}/installation`,
      authorization: jwt,
      expectedStatus: 200,
      stage: `REPOSITORY_INSTALLATION:${repository}`,
    });
    assertRepositoryInstallation(repositoryInstallation);
  }

  await expectNotInstalled(fetchImpl, PREFLIGHT_CONTRACT.excludedRepository, jwt);

  const readTokenResponse = await apiRequest(fetchImpl, {
    method: "POST",
    path: `/app/installations/${PREFLIGHT_CONTRACT.installationId}/access_tokens`,
    authorization: jwt,
    body: { permissions: { metadata: "read" } },
    expectedStatus: 201,
    stage: "TOKEN_MINT",
  });
  const readToken = assertReadOnlyInventoryToken(readTokenResponse);

  const inventory = await apiRequest(fetchImpl, {
    method: "GET",
    path: "/installation/repositories?per_page=100&page=1",
    authorization: readToken,
    expectedStatus: 200,
    stage: "INSTALLATION_REPOSITORIES",
  });
  assertInventory(inventory);

  return Object.freeze({
    appId: PREFLIGHT_CONTRACT.appId,
    clientId: PREFLIGHT_CONTRACT.clientId,
    installationId: PREFLIGHT_CONTRACT.installationId,
    repositorySelection: "selected",
    repositories: Object.freeze([...PREFLIGHT_CONTRACT.managedRepositories]),
    excludedRepository: PREFLIGHT_CONTRACT.excludedRepository,
    permissions: PREFLIGHT_CONTRACT.currentPermissions,
    proposedPermissionDelta: PREFLIGHT_CONTRACT.proposedPermissionDelta,
    remoteConfigurationMutation: false,
    ephemeralReadCredentialIssued: true,
  });
}

function execGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    fail("LOCAL_GIT_PRECONDITION_FAILED");
  }
}

function requireExpectedSha(value) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail("EXPECTED_SHA_INVALID");
  return value;
}

function requireExpectedCiRunId(value) {
  if (typeof value !== "string" || !POSITIVE_INTEGER_PATTERN.test(value)) fail("EXPECTED_CI_INVALID");
  return Number(value);
}

export function assertLocalOwnerPreconditions(expectedSha) {
  if (process.env.GITHUB_ACTIONS === "true") fail("LOCAL_OWNER_ONLY");
  if (os.hostname().split(".", 1)[0].toLowerCase() !== "lenovo") fail("LOCAL_OWNER_ONLY");
  if (execGit(["branch", "--show-current"]) !== "main") fail("LOCAL_MAIN_REQUIRED");
  if (execGit(["rev-parse", "HEAD"]) !== expectedSha) fail("LOCAL_HEAD_DRIFT");
  if (execGit(["status", "--porcelain"]) !== "") fail("LOCAL_WORKTREE_DIRTY");
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "main"], { stdio: "ignore" });
  } catch {
    fail("ORIGIN_FETCH_FAILED");
  }
  if (execGit(["rev-parse", "origin/main"]) !== expectedSha) fail("ORIGIN_MAIN_DRIFT");
}

export async function assertExactMainCi(fetchImpl, expectedSha, expectedCiRunId) {
  const response = await apiRequest(fetchImpl, {
    method: "GET",
    path: `/repos/rozkalnsandris/rozkalns-control-center/actions/runs/${expectedCiRunId}`,
    authorization: "public-read-placeholder",
    expectedStatus: 200,
    stage: "MAIN_CI",
  });
  const value = record(response);
  exactInteger(value.id, expectedCiRunId, "CI_RUN_DRIFT");
  exactString(value.name, "CI", "CI_RUN_DRIFT");
  exactString(value.event, "push", "CI_RUN_DRIFT");
  exactString(value.head_branch, "main", "CI_RUN_DRIFT");
  exactString(value.head_sha, expectedSha, "CI_RUN_DRIFT");
  exactString(value.status, "completed", "CI_NOT_SUCCESSFUL");
  exactString(value.conclusion, "success", "CI_NOT_SUCCESSFUL");
}

async function publicCiRequest(expectedSha, expectedCiRunId, fetchImpl = fetch) {
  const url = new URL(
    `/repos/rozkalnsandris/rozkalns-control-center/actions/runs/${expectedCiRunId}`,
    PREFLIGHT_CONTRACT.apiOrigin,
  );
  const request = new Request(url, {
    method: "GET",
    headers: {
      Accept: PREFLIGHT_CONTRACT.accept,
      "User-Agent": PREFLIGHT_CONTRACT.userAgent,
      "X-GitHub-Api-Version": PREFLIGHT_CONTRACT.apiVersion,
    },
    redirect: "manual",
  });
  let response;
  try {
    response = await fetchImpl(request);
  } catch {
    fail("CI_TRANSPORT_FAILED");
  }
  const payload = await readJsonResponse(response, 200, "MAIN_CI");
  const value = record(payload);
  exactInteger(value.id, expectedCiRunId, "CI_RUN_DRIFT");
  exactString(value.name, "CI", "CI_RUN_DRIFT");
  exactString(value.event, "push", "CI_RUN_DRIFT");
  exactString(value.head_branch, "main", "CI_RUN_DRIFT");
  exactString(value.head_sha, expectedSha, "CI_RUN_DRIFT");
  exactString(value.status, "completed", "CI_NOT_SUCCESSFUL");
  exactString(value.conclusion, "success", "CI_NOT_SUCCESSFUL");
}

function parseArgs(argv) {
  let mode = "plan";
  let expectedSha;
  let expectedCiRunId;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") mode = argv[++index];
    else if (arg === "--expected-sha") expectedSha = argv[++index];
    else if (arg === "--expected-ci-run-id") expectedCiRunId = argv[++index];
    else fail("INVALID_ARGUMENT");
  }
  if (mode !== "plan" && mode !== "observe") fail("INVALID_MODE");
  return { mode, expectedSha, expectedCiRunId };
}

function printPlan() {
  console.log("MODE=PLAN");
  console.log(`APP_ID=${PREFLIGHT_CONTRACT.appId}`);
  console.log(`CLIENT_ID=${PREFLIGHT_CONTRACT.clientId}`);
  console.log(`INSTALLATION_ID=${PREFLIGHT_CONTRACT.installationId}`);
  console.log(`MANAGED_REPOSITORIES=${PREFLIGHT_CONTRACT.managedRepositories.join(",")}`);
  console.log(`EXCLUDED_REPOSITORY=${PREFLIGHT_CONTRACT.excludedRepository}`);
  console.log("CURRENT_PERMISSIONS=actions:read,checks:read,contents:read,issues:read,metadata:read,pull_requests:read");
  console.log(`PROPOSED_PERMISSION_DELTA=${PREFLIGHT_CONTRACT.proposedPermissionDelta}`);
  console.log("OBSERVE_EPHEMERAL_TOKEN_SCOPE=metadata:read");
  console.log("OBSERVE_REMOTE_CONFIGURATION_MUTATION=NO");
  console.log("PERMISSION_GROWTH=NO");
  console.log("WORKER_DEPLOY=NO");
  console.log("PROJECT_CAPABILITY_ENABLEMENT=NO");
}

async function runObserve(args) {
  const expectedSha = requireExpectedSha(args.expectedSha);
  const expectedCiRunId = requireExpectedCiRunId(args.expectedCiRunId);
  assertLocalOwnerPreconditions(expectedSha);
  await publicCiRequest(expectedSha, expectedCiRunId);

  const privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY_PEM;
  const result = await observeGitHubAppState({ privateKeyPem });

  console.log("MODE=OBSERVE");
  console.log(`EXACT_MAIN=${expectedSha}`);
  console.log(`EXACT_MAIN_CI_RUN=${expectedCiRunId}`);
  console.log("EXACT_MAIN_CI=SUCCESS");
  console.log("APP_IDENTITY=PASS");
  console.log("INSTALLATION_IDENTITY=PASS");
  console.log("INSTALLATION_SUSPENDED=NO");
  console.log("REPOSITORY_SELECTION=selected");
  console.log(`REPOSITORY_SET=${result.repositories.join(",")}`);
  console.log(`EXCLUDED_REPOSITORY=${result.excludedRepository}:NOT_INSTALLED`);
  console.log("CURRENT_PERMISSIONS=actions:read,checks:read,contents:read,issues:read,metadata:read,pull_requests:read");
  console.log(`PROPOSED_PERMISSION_DELTA=${result.proposedPermissionDelta}`);
  console.log("EPHEMERAL_READ_CREDENTIAL_ISSUED=YES");
  console.log("EPHEMERAL_READ_CREDENTIAL_SCOPE=metadata:read");
  console.log("REMOTE_GITHUB_APP_CONFIGURATION_MUTATION=NO");
  console.log("PERMISSION_GROWTH=NO");
  console.log("WORKER_DEPLOY=NO");
  console.log("PROJECT_CAPABILITY_ENABLEMENT=NO");
  console.log("GITHUB_APP_PERMISSION_PREFLIGHT=PASS");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === "plan") {
    printPlan();
    return;
  }
  await runObserve(args);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const code = error instanceof GitHubAppNeedsChangesPreflightError ? error.code : "UNEXPECTED_FAILURE";
    console.error(`GITHUB_APP_PERMISSION_PREFLIGHT=FAIL:${code}`);
    process.exitCode = 1;
  });
}
