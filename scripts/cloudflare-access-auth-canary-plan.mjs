#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  accessApplicationProtectsHost,
  exactParentAccessApplication,
  readAccessTokenApplicationAudience,
} from "./cloudflare-access-app-identity.mjs";
import {
  assertNoQueueProducers,
  assertWorkerProducer,
  exactQueueByName,
  exactWorkerConsumer,
} from "./cloudflare-queue-runtime-identity.mjs";
import {
  ACCOUNT_ID,
  DB_ID,
  DB_NAME,
  HOSTNAME,
  WORKER_NAME,
  WRANGLER_VERSION,
  assertBaseInputs,
  assertCi,
  assertRepo,
  assertRequiredBindings,
  assertSubdomainDisabled,
  cfGet,
  listDeployments,
  listDomains,
  run,
  singleDeploymentVersion,
  stop,
  versionDetail,
  wranglerPath,
} from "./cloudflare-ui-rollout-shared.mjs";

const AUTH_PREFIX = `authorize Phase 3 Access auth canary ${HOSTNAME} `;
const APP_CLIENT_ID = "Iv23likDoFtVeWBJfdFS";
const INSTALLATION_ID = "153121564";
const WEBHOOK_SECRET_NAME = "GITHUB_WEBHOOK_SECRET";
const MAIN_QUEUE_NAME = "rozkalns-control-reconciliation";
const DLQ_NAME = "rozkalns-control-reconciliation-dlq";
const CANARY_PATH = "/api/auth/access-canary";
const HEALTH_PATH = "/api/health";
const KID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ACCESS_TOKEN_BYTES = 16384;
const MAX_JWKS_BYTES = 262144;

function parseArgs(argv) {
  const out = { sha: "", ci: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--expected-sha") out.sha = argv[++index] ?? "";
    else if (key === "--expected-ci-run-id") out.ci = argv[++index] ?? "";
    else stop("ARGUMENT_INVALID", `unsupported argument ${key}`);
  }
  return out;
}

function requiredEnvironment() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const accessToken = process.env.CONTROL_ACCESS_TOKEN ?? "";
  if (account !== ACCOUNT_ID) stop("ACCOUNT_ID_INVALID", "Cloudflare account does not match reviewed production account");
  if (!apiToken) stop("API_TOKEN_REQUIRED", "temporary Cloudflare API token is required in the environment");
  if (!accessToken) stop("ACCESS_TOKEN_REQUIRED", "short-lived Control Access token is required in the environment");
  return { apiToken, accessToken };
}

function normalizeIssuer(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    stop("ACCESS_ISSUER_INVALID", "Access issuer must be a bounded HTTPS Cloudflare Access origin");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    stop("ACCESS_ISSUER_INVALID", "Access issuer is not a valid URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !hostname.endsWith(".cloudflareaccess.com") ||
    hostname === "cloudflareaccess.com" ||
    value !== url.origin
  ) {
    stop("ACCESS_ISSUER_INVALID", "Access issuer must be an exact https://<team>.cloudflareaccess.com origin");
  }
  return url.origin;
}

function decodeJwtJsonSegment(segment, code) {
  if (!JWT_SEGMENT_PATTERN.test(segment)) stop(code, "Access token contains an invalid compact JWT segment");
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    stop(code, "Access token JSON segment could not be decoded");
  }
}

function parseAccessTokenForVerification(token, expectedAudience) {
  if (typeof token !== "string" || token.length === 0 || Buffer.byteLength(token, "utf8") > MAX_ACCESS_TOKEN_BYTES) {
    stop("ACCESS_TOKEN_INVALID", "Access token is missing or oversized");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    stop("ACCESS_TOKEN_INVALID", "Access token is not a compact JWT");
  }

  const header = decodeJwtJsonSegment(parts[0], "ACCESS_TOKEN_HEADER_INVALID");
  const payload = decodeJwtJsonSegment(parts[1], "ACCESS_TOKEN_PAYLOAD_INVALID");
  if (header?.alg !== "RS256" || typeof header?.kid !== "string" || !KID_PATTERN.test(header.kid)) {
    stop("ACCESS_TOKEN_HEADER_INVALID", "Access token must use RS256 with one bounded kid");
  }
  if (payload?.type !== "app") stop("ACCESS_TOKEN_TYPE_INVALID", "Access token must be an application token");
  if (!Array.isArray(payload?.aud) || payload.aud.length !== 1 || payload.aud[0] !== expectedAudience) {
    stop("ACCESS_TOKEN_AUDIENCE_INVALID", "Access token AUD does not match the exact parent Access application");
  }

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(payload?.exp) || payload.exp <= now) stop("ACCESS_TOKEN_EXPIRED", "Access token is expired or has invalid exp");
  if (!Number.isSafeInteger(payload?.iat) || payload.iat > now + 60) stop("ACCESS_TOKEN_IAT_INVALID", "Access token iat is invalid or in the future");
  if (payload?.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > now + 60)) {
    stop("ACCESS_TOKEN_NOT_YET_VALID", "Access token nbf is invalid or in the future");
  }

  return {
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: parts[2],
    kid: header.kid,
    issuer: normalizeIssuer(payload?.iss),
    audience: payload.aud[0],
  };
}

async function readIssuerJwks(issuer) {
  let response;
  try {
    response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    stop("ACCESS_JWKS_READ_FAILED", "Access signing-key request failed");
  }
  if (response.status !== 200) stop("ACCESS_JWKS_STATUS", `Access signing-key endpoint returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) stop("ACCESS_JWKS_MEDIA_TYPE", "Access signing-key response was not JSON");

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JWKS_BYTES) stop("ACCESS_JWKS_OVERSIZED", "Access signing-key response exceeded the size bound");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    stop("ACCESS_JWKS_INVALID", "Access signing-key response JSON could not be parsed");
  }
  if (!Array.isArray(payload?.keys) || payload.keys.length === 0 || payload.keys.length > 8) {
    stop("ACCESS_JWKS_INVALID", "Access signing-key response did not contain a bounded key set");
  }
  return payload.keys;
}

async function verifyShortLivedAccessToken(token, expectedAudience) {
  const parsed = parseAccessTokenForVerification(token, expectedAudience);
  const keys = await readIssuerJwks(parsed.issuer);
  const matches = keys.filter(
    (key) =>
      key?.kid === parsed.kid &&
      key?.kty === "RSA" &&
      key?.alg === "RS256" &&
      key?.use === "sig" &&
      typeof key?.n === "string" &&
      typeof key?.e === "string",
  );
  if (matches.length !== 1) stop("ACCESS_JWK_NOT_FOUND", "Access token kid was not uniquely present in the reviewed JWKS shape");

  let publicKey;
  try {
    publicKey = createPublicKey({ key: matches[0], format: "jwk" });
  } catch {
    stop("ACCESS_JWK_INVALID", "Access signing JWK could not be imported");
  }
  const signature = Buffer.from(parsed.signature, "base64url");
  if (signature.length === 0) stop("ACCESS_TOKEN_SIGNATURE_INVALID", "Access token signature is empty");
  if (!verify("RSA-SHA256", Buffer.from(parsed.signingInput, "ascii"), publicKey, signature)) {
    stop("ACCESS_TOKEN_SIGNATURE_INVALID", "Access token signature verification failed");
  }
  return { issuer: parsed.issuer, audience: parsed.audience };
}

function basePlainTextBindings() {
  return {
    GITHUB_APP_CLIENT_ID: APP_CLIENT_ID,
    GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
    CONTROL_LIVE_READ_ENABLED: "true",
    CONTROL_WEBHOOK_RUNTIME_ENABLED: "true",
  };
}

function assertSecretBinding(detail, name, codePrefix) {
  const bindings = detail?.resources?.bindings;
  if (!Array.isArray(bindings)) stop(`${codePrefix}_BINDINGS_INVALID`, "version bindings were not available");
  const matches = bindings.filter(
    (binding) => binding?.name === name && (binding?.type === "secret_text" || binding?.type === "secret_key"),
  );
  if (matches.length !== 1) stop(`${codePrefix}_${name}_SECRET`, `${name} secret binding was not uniquely present`);
}

function assertPreActivationVersion(detail, codePrefix) {
  assertRequiredBindings(detail, codePrefix);
  assertSecretBinding(detail, WEBHOOK_SECRET_NAME, codePrefix);
  const plain = (detail?.resources?.bindings ?? []).filter((binding) => binding?.type === "plain_text");
  const expected = basePlainTextBindings();
  if (JSON.stringify(plain.map((binding) => binding?.name).sort()) !== JSON.stringify(Object.keys(expected).sort())) {
    stop(`${codePrefix}_PLAIN_BINDING_SET`, "Worker plain-text binding set differs from the reviewed pre-activation contract");
  }
  for (const [name, value] of Object.entries(expected)) {
    const matches = plain.filter((binding) => binding?.name === name && binding?.text === value);
    if (matches.length !== 1) stop(`${codePrefix}_${name}_BINDING`, `${name} plain-text binding did not match the reviewed value`);
  }
}

async function assertSourceConfig() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) stop("WRANGLER_PIN_INVALID", "repository Wrangler pin changed");
  if (pkg?.scripts?.["cf:access-auth-canary-plan"] !== "node scripts/cloudflare-access-auth-canary-plan.mjs") {
    stop("PLAN_SCRIPT_ENTRY_INVALID", "Access auth canary PLAN package entry is missing or changed");
  }
  if (pkg?.scripts?.["cf:access-auth-canary-gate"] !== "node scripts/cloudflare-access-auth-canary-gate.mjs") {
    stop("APPLY_GATE_ENTRY_INVALID", "existing Access auth canary APPLY gate entry changed");
  }

  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  if (config?.name !== WORKER_NAME) stop("WORKER_NAME_INVALID", "Worker target changed");
  if (config?.workers_dev !== false) stop("WORKERS_DEV_NOT_DISABLED", "workers.dev must remain disabled");
  if (config?.preview_urls !== false) stop("PREVIEW_URLS_NOT_DISABLED", "Preview URLs must remain disabled");
  if (JSON.stringify(config?.vars) !== JSON.stringify(basePlainTextBindings())) {
    stop("SOURCE_VARS_INVALID", "source vars must remain the reviewed pre-activation set");
  }

  const requiredSecrets = config?.secrets?.required;
  if (!Array.isArray(requiredSecrets) || JSON.stringify(requiredSecrets) !== JSON.stringify(["GITHUB_APP_PRIVATE_KEY_PEM", WEBHOOK_SECRET_NAME])) {
    stop("SECRET_CONTRACT_INVALID", "required Worker secret contract changed");
  }
  const d1 = Array.isArray(config?.d1_databases) ? config.d1_databases : [];
  if (d1.length !== 1 || d1[0]?.binding !== "CONTROL_DB" || d1[0]?.database_name !== DB_NAME || d1[0]?.database_id !== DB_ID) {
    stop("D1_BINDING_INVALID", "production D1 binding changed");
  }
  if (config?.queues?.producers?.length !== 1 || config.queues.producers[0]?.binding !== "RECONCILIATION_QUEUE" || config.queues.producers[0]?.queue !== MAIN_QUEUE_NAME) {
    stop("QUEUE_PRODUCER_CONFIG_INVALID", "reviewed Queue producer configuration changed");
  }
  if (config?.assets?.directory !== "./dist/client" || JSON.stringify(config?.assets?.run_worker_first) !== JSON.stringify(["/api/*"])) {
    stop("ASSETS_CONFIG_INVALID", "reviewed SPA/API routing configuration changed");
  }
  const version = run(wranglerPath(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "installed Wrangler version changed");
}

async function exactDomain(apiToken) {
  const service = await listDomains(apiToken);
  const target = await cfGet(apiToken, `/workers/domains?hostname=${encodeURIComponent(HOSTNAME)}`);
  if (!Array.isArray(target)) stop("DOMAIN_TARGET_INVENTORY_INVALID", "target domain inventory was not an array");
  const matches = [...service, ...target].filter((domain) => domain?.hostname === HOSTNAME && domain?.service === WORKER_NAME);
  const ids = [...new Set(matches.map((domain) => domain?.id).filter(Boolean))];
  if (ids.length !== 1 || matches.length !== 2) stop("DOMAIN_STATE", "exact Worker Custom Domain was not uniquely proven in both inventories");
  return matches[0];
}

async function queueTopology(apiToken) {
  const queues = await cfGet(apiToken, "/queues");
  if (!Array.isArray(queues)) stop("QUEUE_INVENTORY_INVALID", "Queue inventory was not an array");
  let main;
  let dlq;
  try {
    main = exactQueueByName(queues, MAIN_QUEUE_NAME);
    dlq = exactQueueByName(queues, DLQ_NAME);
    assertWorkerProducer(main, WORKER_NAME);
    assertNoQueueProducers(dlq);
  } catch (error) {
    stop(`PLAN_${error?.code ?? "QUEUE_IDENTITY"}`, error instanceof Error ? error.message : "Queue identity proof failed");
  }

  const mainConsumers = await cfGet(apiToken, `/queues/${encodeURIComponent(main.queue_id)}/consumers`);
  const dlqConsumers = await cfGet(apiToken, `/queues/${encodeURIComponent(dlq.queue_id)}/consumers`);
  let mainConsumer;
  let dlqConsumer;
  try {
    mainConsumer = exactWorkerConsumer(mainConsumers, {
      queueName: MAIN_QUEUE_NAME,
      workerName: WORKER_NAME,
      batchSize: 10,
      maxWaitTimeMs: 5000,
      maxRetries: 3,
      maxConcurrency: 1,
      retryDelay: 30,
      deadLetterQueue: DLQ_NAME,
    });
    dlqConsumer = exactWorkerConsumer(dlqConsumers, {
      queueName: DLQ_NAME,
      workerName: WORKER_NAME,
      batchSize: 10,
      maxWaitTimeMs: 5000,
      maxRetries: 3,
      maxConcurrency: 1,
      retryDelay: 0,
    });
  } catch (error) {
    stop(`PLAN_${error?.code ?? "QUEUE_CONSUMER_IDENTITY"}`, error instanceof Error ? error.message : "Queue consumer proof failed");
  }
  return { main, dlq, mainConsumer, dlqConsumer };
}

async function resolveParentAccessByToken(apiToken, accessToken) {
  let audienceHint;
  try {
    audienceHint = readAccessTokenApplicationAudience(accessToken);
  } catch (error) {
    stop(`PLAN_${error?.code ?? "ACCESS_TOKEN_AUDIENCE"}`, error instanceof Error ? error.message : "Access token audience hint failed");
  }

  const apps = await cfGet(apiToken, "/access/apps");
  let parent;
  try {
    parent = exactParentAccessApplication(apps, audienceHint);
  } catch (error) {
    stop(`PLAN_${error?.code ?? "PARENT_APP"}`, error instanceof Error ? error.message : "parent Access application proof failed");
  }
  if (!accessApplicationProtectsHost(parent, HOSTNAME)) {
    stop("PLAN_PARENT_APP_DESTINATION", "AUD-selected parent Access application does not protect the reviewed Control hostname");
  }

  const identity = await verifyShortLivedAccessToken(accessToken, parent.aud);
  if (identity.audience !== audienceHint || identity.audience !== parent.aud) {
    stop("PLAN_ACCESS_AUDIENCE_REBIND", "verified Access audience did not re-bind to the AUD-selected parent application");
  }
  return { parent, identity };
}

async function accessResponse(path, accessToken) {
  let response;
  try {
    response = await fetch(`https://${HOSTNAME}${path}`, {
      headers: { Accept: "application/json", "cf-access-token": accessToken },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    stop("PLAN_ACCESS_READ", "Access-authenticated Control request failed");
  }
  return response;
}

async function assertPreActivationRoutes(accessToken) {
  const canary = await accessResponse(CANARY_PATH, accessToken);
  if (canary.status !== 404 && canary.status !== 503) {
    stop("PLAN_CANARY_STATE", "pre-activation canary must be absent or fail-closed disabled");
  }
  const health = await accessResponse(HEALTH_PATH, accessToken);
  if (health.status !== 200) stop("PLAN_HEALTH_STATUS", "protected health request did not return HTTP 200");
  let body;
  try {
    body = await health.json();
  } catch {
    stop("PLAN_HEALTH_JSON", "protected health response was not JSON");
  }
  if (body?.status !== "ok" || body?.service !== WORKER_NAME) stop("PLAN_HEALTH_SHAPE", "protected health response did not match");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertBaseInputs(args.sha, args.ci);
  assertRepo(args.sha);
  await assertCi(args.sha, args.ci);
  await assertSourceConfig();
  const { apiToken, accessToken } = requiredEnvironment();

  const active = singleDeploymentVersion(await listDeployments(apiToken), "PLAN");
  assertPreActivationVersion(await versionDetail(apiToken, active.versionId), "PLAN");
  await assertSubdomainDisabled(apiToken, "PLAN");
  const domain = await exactDomain(apiToken);
  const queues = await queueTopology(apiToken);
  const { parent, identity } = await resolveParentAccessByToken(apiToken, accessToken);
  await assertPreActivationRoutes(accessToken);

  console.log("ACCESS_AUTH_CANARY_GATE=PLAN_PASS");
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("WORKER_DEPLOY=NOT_EXECUTED_IN_PLAN");
  console.log("ACCESS_APP_POLICY_MUTATION=NO");
  console.log("D1_MUTATION=NO");
  console.log("QUEUE_MUTATION=NO");
  console.log("GITHUB_PERMISSION_GROWTH=NO");
  console.log(`SOURCE_SHA=${args.sha}`);
  console.log(`CI_RUN_ID=${args.ci}`);
  console.log(`CURRENT_VERSION_ID=${active.versionId}`);
  console.log(`CURRENT_DEPLOYMENT_ID=${active.deploymentId}`);
  console.log(`DOMAIN_ID=${domain.id}`);
  console.log(`PARENT_ACCESS_APP_ID=${parent.id}`);
  console.log(`PARENT_ACCESS_APP_AUD=${identity.audience}`);
  console.log(`ACCESS_ISSUER=${identity.issuer}`);
  console.log(`MAIN_QUEUE_ID=${queues.main.queue_id}`);
  console.log(`MAIN_QUEUE_CONSUMER_ID=${queues.mainConsumer.consumer_id}`);
  console.log(`DLQ_ID=${queues.dlq.queue_id}`);
  console.log(`DLQ_CONSUMER_ID=${queues.dlqConsumer.consumer_id}`);
  console.log("PREACTIVATION_CANARY=INACTIVE_FAIL_CLOSED");
  console.log("ACCESS_TOKEN_SIGNATURE=VERIFIED_RS256_JWKS");
  console.log("PARENT_DISCOVERY=TOKEN_AUD_THEN_SIGNATURE_REBIND");
  console.log(
    `OWNER_AUTHORIZATION=${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${active.versionId} deployment ${active.deploymentId} domain ${domain.id} access ${parent.id} aud ${identity.audience} issuer ${identity.issuer} mainq ${queues.main.queue_id} mainc ${queues.mainConsumer.consumer_id} dlq ${queues.dlq.queue_id} dlqc ${queues.dlqConsumer.consumer_id} inactive`,
  );
  console.log("NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES");
}

await main().catch(() => {
  console.error("AUTHORIZATION_STATUS=NOT_CONSUMED");
  if (!process.exitCode) process.exitCode = 1;
});
