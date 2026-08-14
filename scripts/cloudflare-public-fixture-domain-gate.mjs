#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  ACCOUNT_ID,
  PUBLIC_HOSTNAME,
  WORKER_NAME,
  ZONE_NAME,
  assertBaseInputs,
  assertExactActiveFixtureVersion,
  assertExactMainCi,
  assertExactRepositoryState,
  assertSourceFixtureConfig,
  cleanEnv,
  listDomains,
  stop,
} from "./cloudflare-public-rollout-common.mjs";

const AUTH_PREFIX = `authorize Phase 2 public fixture domain attach ${PUBLIC_HOSTNAME} `;
const CF = "https://api.cloudflare.com/client/v4";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseArgs(argv) {
  const args = { mode: "plan", sha: "", ci: "", version: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") args.mode = argv[++index] ?? "";
    else if (arg === "--expected-sha") args.sha = argv[++index] ?? "";
    else if (arg === "--expected-ci-run-id") args.ci = argv[++index] ?? "";
    else if (arg === "--expected-version-id") args.version = argv[++index] ?? "";
    else stop("ARGUMENT_INVALID", `unsupported argument ${arg}`);
  }
  if (args.mode !== "plan" && args.mode !== "apply") {
    stop("MODE_INVALID", "mode must be plan or apply");
  }
  return args;
}

function assertVersionId(version) {
  if (!UUID_PATTERN.test(version)) {
    stop("EXPECTED_VERSION_INVALID", "expected version id must be a lowercase UUID");
  }
}

function printPlan() {
  console.log("MODE=PLAN");
  console.log(`WORKER=${WORKER_NAME}`);
  console.log(`HOSTNAME=${PUBLIC_HOSTNAME}`);
  console.log(`ZONE_NAME=${ZONE_NAME}`);
  console.log(`ACCOUNT_ID=${ACCOUNT_ID}`);
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("AUTHORIZED_APPLY=CUSTOM_DOMAIN_ATTACH_EXACT_ACTIVE_VERSION");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("LIVE_GITHUB_RECONCILIATION=DISABLED");
  console.log(
    `OWNER_AUTHORIZATION_FORMAT=${AUTH_PREFIX}<exact-main-sha> ci <exact-ci-run-id> version <exact-version-id>`,
  );
  console.log("NO_BLIND_RETRY_AFTER_DOMAIN_ATTACH_STARTED=YES");
}

function runLocalValidation() {
  const result = spawnSync("npm", ["run", "check"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: cleanEnv(),
  });
  if (result.error || result.status !== 0) {
    stop("LOCAL_VALIDATION_FAILED", "npm run check failed before domain attach");
  }
}

async function attachDomain(token) {
  let response;
  try {
    response = await fetch(`${CF}/accounts/${ACCOUNT_ID}/workers/domains`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hostname: PUBLIC_HOSTNAME,
        service: WORKER_NAME,
        zone_name: ZONE_NAME,
      }),
    });
  } catch {
    stop("DOMAIN_ATTACH_FAILED", "Custom Domain attach request failed after authorization was consumed");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    stop("DOMAIN_ATTACH_FAILED", "Custom Domain attach returned invalid JSON after authorization was consumed");
  }

  if (!response.ok || payload?.success !== true) {
    stop("DOMAIN_ATTACH_FAILED", `Custom Domain attach failed with HTTP ${response.status}`);
  }
  return payload.result;
}

function assertExpectedDomain(domains) {
  const matching = domains.filter((domain) => domain?.hostname === PUBLIC_HOSTNAME);
  if (matching.length !== 1) {
    stop("POST_VERIFY_DOMAIN_COUNT", "expected exactly one target Custom Domain");
  }
  const domain = matching[0];
  if (domain?.service !== WORKER_NAME) {
    stop("POST_VERIFY_DOMAIN_SERVICE", "target Custom Domain is not attached to the reviewed Worker");
  }
  if (domain?.zone_name && domain.zone_name !== ZONE_NAME) {
    stop("POST_VERIFY_DOMAIN_ZONE", "target Custom Domain is attached to an unexpected zone");
  }
  return domain;
}

async function apply(args) {
  assertBaseInputs(args.sha, args.ci);
  assertVersionId(args.version);

  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";
  if (!token) stop("CLOUDFLARE_TOKEN_REQUIRED", "apply requires a Workers Scripts write-capable API token");
  if (authorization !== `${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${args.version}`) {
    stop("OWNER_AUTHORIZATION_INVALID", "owner authorization does not match exact main SHA, CI run and Worker version");
  }

  assertExactRepositoryState(args.sha);
  await assertSourceFixtureConfig();
  await assertExactMainCi(args.sha, args.ci);
  await assertExactActiveFixtureVersion(token, args.version, { domainMustBeAbsent: true });
  runLocalValidation();

  // Re-resolve every mutable gate immediately before the sole Cloudflare write.
  assertExactRepositoryState(args.sha);
  await assertExactMainCi(args.sha, args.ci);
  await assertExactActiveFixtureVersion(token, args.version, { domainMustBeAbsent: true });

  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("DOMAIN_ATTACH_STARTED=YES");

  let attached;
  try {
    attached = await attachDomain(token);
  } catch (error) {
    console.error("POST_DOMAIN_ATTACH_STATE=RECONCILIATION_REQUIRED");
    throw error;
  }

  try {
    await delay(2000);
    await assertExactActiveFixtureVersion(token, args.version, { domainMustBeAbsent: false });
    const domain = assertExpectedDomain(await listDomains(token));
    const domainId = domain?.id ?? attached?.id;
    if (typeof domainId !== "string" || domainId.length === 0) {
      stop("POST_VERIFY_DOMAIN_ID", "Custom Domain did not expose a stable id");
    }

    console.log("PUBLIC_FIXTURE_DOMAIN_GATE=PASS");
    console.log(`DOMAIN_ID=${domainId}`);
    console.log(`HOSTNAME=${PUBLIC_HOSTNAME}`);
    console.log(`WORKER=${WORKER_NAME}`);
    console.log(`ACTIVE_VERSION_ID=${args.version}`);
    console.log("ACTIVE_TRAFFIC_PERCENT=100");
    console.log("WORKERS_DEV=DISABLED");
    console.log("PREVIEW_URLS=DISABLED");
    console.log("LIVE_GITHUB_RECONCILIATION=DISABLED");
  } catch (error) {
    console.error("POST_DOMAIN_ATTACH_STATE=RECONCILIATION_REQUIRED");
    throw error;
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") printPlan();
  else await apply(args);
} catch {
  if (process.exitCode !== 1) {
    console.error("UNEXPECTED_FAILURE: sanitized public fixture domain gate failure");
    process.exitCode = 1;
  }
}
