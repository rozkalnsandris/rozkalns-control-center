#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

import { accessApplicationProtectsHost } from "./cloudflare-access-app-identity.mjs";
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
  childEnvironment,
  cleanEnv,
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const KID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ACCESS_TOKEN_BYTES = 16384;
const MAX_JWKS_BYTES = 262144;
const ACCESS_BINDINGS = [
  "CONTROL_ACCESS_AUTH_CANARY_ENABLED",
  "CONTROL_ACCESS_ISSUER",
  "CONTROL_ACCESS_AUDIENCE",
];

let deployStarted = false;

function parseArgs(argv) {
  const out = {
    mode: "plan",
    sha: "",
    ci: "",
    currentVersion: "",
    currentDeployment: "",
    domainId: "",
    accessAppId: "",
    accessAud: "",
    issuer: "",
    mainQueueId: "",
    mainConsumerId: "",
    dlqId: "",
    dlqConsumerId: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--mode") out.mode = argv[++index] ?? "";
    else if (key === "--expected-sha") out.sha = argv[++index] ?? "";
    else if (key === "--expected-ci-run-id") out.ci = argv[++index] ?? "";
    else if (key === "--expected-current-version-id") out.currentVersion = argv[++index] ?? "";
    else if (key === "--expected-current-deployment-id") out.currentDeployment = argv[++index] ?? "";
    else if (key === "--expected-domain-id") out.domainId = argv[++index] ?? "";
    else if (key === "--expected-access-app-id") out.accessAppId = argv[++index] ?? "";
    else if (key === "--expected-access-aud") out.accessAud = argv[++index] ?? "";
    else if (key === "--expected-access-issuer") out.issuer = argv[++index] ?? "";
    else if (key === "--expected-main-queue-id") out.mainQueueId = argv[++index] ?? "";
    else if (key === "--expected-main-consumer-id") out.mainConsumerId = argv[++index] ?? "";
    else if (key === "--expected-dlq-id") out.dlqId = argv[++index] ?? "";
    else if (key === "--expected-dlq-consumer-id") out.dlqConsumerId = argv[++index] ?? "";
    else stop("ARGUMENT_INVALID", `unsupported argument ${key}`);
  }

  if (out.mode !== "plan" && out.mode !== "apply") {
    stop("MODE_INVALID", "mode must be plan or apply");
  }
  return out;
}

function assertUuid(value, code, label) {
  if (!UUID_PATTERN.test(value)) stop(code, `${label} must be a lowercase UUID`);
}

function assertOpaqueId(value, code, label) {
  if (!OPAQUE_ID_PATTERN.test(value)) stop(code, `${label} must be a bounded opaque identifier`);
}

function assertAudience(value) {
  if (!AUDIENCE_PATTERN.test(value)) stop("ACCESS_AUD_INVALID", "Access application audience is invalid");
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

function requiredEnvironment() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const accessToken = process.env.CONTROL_ACCESS_TOKEN ?? "";
  if (account !== ACCOUNT_ID) stop("ACCOUNT_ID_INVALID", "Cloudflare account does not match reviewed production account");
  if (!apiToken) stop("API_TOKEN_REQUIRED", "temporary Cloudflare API token is required in the environment");
  if (!accessToken) stop("ACCESS_TOKEN_REQUIRED", "short-lived Control Access token is required in the environment");
  return { apiToken, accessToken };
}

function assertSecretBinding(detail, name, codePrefix) {
  const bindings = detail?.resources?.bindings;
  if (!Array.isArray(bindings)) stop(`${codePrefix}_BINDINGS_INVALID`, "version bindings were not available");
  const matches = bindings.filter(
    (binding) => binding?.name === name && (binding?.type === "secret_text" || binding?.type === "secret_key"),
  );
  if (matches.length !== 1) stop(`${codePrefix}_${name}_SECRET`, `${name} secret binding was not uniquely present`);
}

function assertExactPlainTextBindings(detail, expected, codePrefix) {
  const bindings = detail?.resources?.bindings;
  if (!Array.isArray(bindings)) stop(`${codePrefix}_BINDINGS_INVALID`, "version bindings were not available");
  const plain = bindings.filter((binding) => binding?.type === "plain_text");
  const expectedNames = Object.keys(expected).sort();
  const actualNames = plain.map((binding) => binding?.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    stop(`${codePrefix}_PLAIN_BINDING_SET`, "Worker plain-text binding set differs from the reviewed contract");
  }
  for (const [name, value] of Object.entries(expected)) {
    const matches = plain.filter((binding) => binding?.name === name && binding?.text === value);
    if (matches.length !== 1) stop(`${codePrefix}_${name}_BINDING`, `${name} plain-text binding did not match the reviewed value`);
  }
}

function basePlainTextBindings() {
  return {
    GITHUB_APP_CLIENT_ID: APP_CLIENT_ID,
    GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
    CONTROL_LIVE_READ_ENABLED: "true",
    CONTROL_WEBHOOK_RUNTIME_ENABLED: "true",
  };
}

function assertPreActivationVersion(detail, codePrefix) {
  assertRequiredBindings(detail, codePrefix);
  assertSecretBinding(detail, WEBHOOK_SECRET_NAME, codePrefix);
  assertExactPlainTextBindings(detail, basePlainTextBindings(), codePrefix);
}

function assertActivatedVersion(detail, issuer, audience, codePrefix) {
  assertRequiredBindings(detail, codePrefix);
  assertSecretBinding(detail, WEBHOOK_SECRET_NAME, codePrefix);
  assertExactPlainTextBindings(
    detail,
    {
      ...basePlainTextBindings(),
      CONTROL_ACCESS_AUTH_CANARY_ENABLED: "true",
      CONTROL_ACCESS_ISSUER: issuer,
      CONTROL_ACCESS_AUDIENCE: audience,
    },
    codePrefix,
  );
}

async function assertSourceConfig() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) stop("WRANGLER_PIN_INVALID", "repository Wrangler pin changed");
  if (pkg?.scripts?.["cf:access-auth-canary-gate"] !== "node scripts/cloudflare-access-auth-canary-gate.mjs") {
    stop("GATE_SCRIPT_ENTRY_INVALID", "Access auth canary gate package entry is missing or changed");
  }

  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  if (config?.name !== WORKER_NAME) stop("WORKER_NAME_INVALID", "Worker target changed");
  if (config?.workers_dev !== false) stop("WORKERS_DEV_NOT_DISABLED", "workers.dev must remain disabled");
  if (config?.preview_urls !== false) stop("PREVIEW_URLS_NOT_DISABLED", "Preview URLs must remain disabled");
  if (JSON.stringify(config?.vars) !== JSON.stringify(basePlainTextBindings())) {
    stop("SOURCE_VARS_INVALID", "source vars must remain the reviewed pre-activation set");
  }
  for (const name of ACCESS_BINDINGS) {
    if (Object.hasOwn(config?.vars ?? {}, name)) stop("SOURCE_ACCESS_CONFIG_PRESENT", `${name} must not be committed in this source-only gate slice`);
  }

  const requiredSecrets = config?.secrets?.required;
  if (
    !Array.isArray(requiredSecrets) ||
    JSON.stringify(requiredSecrets) !== JSON.stringify(["GITHUB_APP_PRIVATE_KEY_PEM", WEBHOOK_SECRET_NAME])
  ) {
    stop("SECRET_CONTRACT_INVALID", "required Worker secret contract changed");
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

  const producers = config?.queues?.producers;
  if (
    !Array.isArray(producers) ||
    producers.length !== 1 ||
    producers[0]?.binding !== "RECONCILIATION_QUEUE" ||
    producers[0]?.queue !== MAIN_QUEUE_NAME
  ) {
    stop("QUEUE_PRODUCER_CONFIG_INVALID", "reviewed Queue producer configuration changed");
  }

  const expectedConsumers = [
    {
      queue: MAIN_QUEUE_NAME,
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 3,
      retry_delay: 30,
      max_concurrency: 1,
      dead_letter_queue: DLQ_NAME,
    },
    {
      queue: DLQ_NAME,
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 3,
      max_concurrency: 1,
    },
  ];
  if (JSON.stringify(config?.queues?.consumers) !== JSON.stringify(expectedConsumers)) {
    stop("QUEUE_CONSUMER_CONFIG_INVALID", "reviewed Queue consumer configuration changed");
  }

  if (
    config?.assets?.directory !== "./dist/client" ||
    config?.assets?.not_found_handling !== "single-page-application" ||
    JSON.stringify(config?.assets?.run_worker_first) !== JSON.stringify(["/api/*"])
  ) {
    stop("ASSETS_CONFIG_INVALID", "reviewed SPA/API routing configuration changed");
  }
  for (const forbidden of ["route", "routes", "triggers", "custom_domain", "custom_domains"]) {
    if (Object.hasOwn(config, forbidden)) stop("SOURCE_ROUTING_PRESENT", `${forbidden} is forbidden in this production gate source`);
  }

  const version = run(wranglerPath(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "installed Wrangler version changed");
}

async function targetDomains(apiToken) {
  const domains = await cfGet(apiToken, `/workers/domains?hostname=${encodeURIComponent(HOSTNAME)}`);
  if (!Array.isArray(domains)) stop("TARGET_DOMAIN_INVENTORY_INVALID", "target domain inventory was not an array");
  return domains;
}

function exactDomain(domains, expectedDomainId = "", codePrefix = "DOMAIN") {
  const matches = domains.filter(
    (domain) =>
      domain?.hostname === HOSTNAME &&
      domain?.service === WORKER_NAME &&
      (expectedDomainId === "" || domain?.id === expectedDomainId),
  );
  if (matches.length !== 1) stop(`${codePrefix}_STATE`, "exact Worker Custom Domain was not uniquely proven");
  const domain = matches[0];
  if (typeof domain?.id !== "string" || domain.id.length === 0 || domain.id.length > 128) {
    stop(`${codePrefix}_ID`, "Custom Domain id is invalid");
  }
  return domain;
}

async function readExactDomain(apiToken, expectedDomainId = "", codePrefix = "DOMAIN") {
  const service = exactDomain(await listDomains(apiToken), expectedDomainId, `${codePrefix}_SERVICE`);
  const target = exactDomain(await targetDomains(apiToken), expectedDomainId, `${codePrefix}_TARGET`);
  if (service.id !== target.id) stop(`${codePrefix}_ID_MISMATCH`, "service and hostname domain inventories disagreed");
  return service;
}

async function listQueues(apiToken) {
  const queues = await cfGet(apiToken, "/queues");
  if (!Array.isArray(queues)) stop("QUEUE_INVENTORY_INVALID", "Queue inventory was not an array");
  return queues;
}

async function listQueueConsumers(apiToken, queueId) {
  const consumers = await cfGet(apiToken, `/queues/${encodeURIComponent(queueId)}/consumers`);
  if (!Array.isArray(consumers)) stop("QUEUE_CONSUMERS_INVALID", "Queue consumer inventory was not an array");
  return consumers;
}

function queueHelperError(error, codePrefix) {
  stop(`${codePrefix}_${error?.code ?? "QUEUE_IDENTITY"}`, error instanceof Error ? error.message : "Queue identity proof failed");
}

async function assertQueueTopology(apiToken, expected = {}, codePrefix = "QUEUE") {
  const queues = await listQueues(apiToken);
  let main;
  let dlq;
  try {
    main = exactQueueByName(queues, MAIN_QUEUE_NAME, expected.mainQueueId ?? "");
    dlq = exactQueueByName(queues, DLQ_NAME, expected.dlqId ?? "");
    assertWorkerProducer(main, WORKER_NAME);
    assertNoQueueProducers(dlq);
  } catch (error) {
    queueHelperError(error, codePrefix);
  }

  const mainConsumers = await listQueueConsumers(apiToken, main.queue_id);
  const dlqConsumers = await listQueueConsumers(apiToken, dlq.queue_id);
  let mainConsumer;
  let dlqConsumer;
  try {
    mainConsumer = exactWorkerConsumer(
      mainConsumers,
      {
        queueName: MAIN_QUEUE_NAME,
        workerName: WORKER_NAME,
        batchSize: 10,
        maxWaitTimeMs: 5000,
        maxRetries: 3,
        maxConcurrency: 1,
        retryDelay: 30,
        deadLetterQueue: DLQ_NAME,
      },
      expected.mainConsumerId ?? "",
    );
    dlqConsumer = exactWorkerConsumer(
      dlqConsumers,
      {
        queueName: DLQ_NAME,
        workerName: WORKER_NAME,
        batchSize: 10,
        maxWaitTimeMs: 5000,
        maxRetries: 3,
        maxConcurrency: 1,
        retryDelay: 0,
      },
      expected.dlqConsumerId ?? "",
    );
  } catch (error) {
    queueHelperError(error, codePrefix);
  }
  return { main, dlq, mainConsumer, dlqConsumer };
}

async function listAccessApps(apiToken) {
  const apps = await cfGet(apiToken, "/access/apps");
  if (!Array.isArray(apps)) stop("ACCESS_APP_INVENTORY_INVALID", "Access application inventory was not an array");
  return apps;
}

function exactParentAccessApp(apps, expected = {}, codePrefix = "ACCESS") {
  const matches = apps.filter(
    (app) =>
      app?.type === "self_hosted" &&
      accessApplicationProtectsHost(app, HOSTNAME) &&
      (expected.appId === undefined || app?.id === expected.appId) &&
      (expected.aud === undefined || app?.aud === expected.aud),
  );
  if (matches.length !== 1) stop(`${codePrefix}_PARENT_APP`, "exact parent Access application was not uniquely proven");
  const app = matches[0];
  assertUuid(app?.id ?? "", `${codePrefix}_PARENT_APP_ID`, "parent Access application id");
  if (!AUDIENCE_PATTERN.test(app?.aud ?? "")) stop(`${codePrefix}_PARENT_APP_AUD`, "parent Access application AUD is invalid");
  return app;
}

function decodeJwtJsonSegment(segment, code) {
  if (!JWT_SEGMENT_PATTERN.test(segment)) stop(code, "Access token contains an invalid compact JWT segment");
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    stop(code, "Access token JSON segment could not be decoded");
  }
}

function parseAccessToken(token, expectedAudience) {
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
  if (
    !Array.isArray(payload?.aud) ||
    payload.aud.length !== 1 ||
    payload.aud[0] !== expectedAudience ||
    !AUDIENCE_PATTERN.test(payload.aud[0])
  ) {
    stop("ACCESS_TOKEN_AUDIENCE_INVALID", "Access token AUD does not match the exact parent Access application");
  }
  const issuer = normalizeIssuer(payload?.iss);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(payload?.exp) || payload.exp <= now) stop("ACCESS_TOKEN_EXPIRED", "Access token is expired or has invalid exp");
  if (payload?.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > now)) {
    stop("ACCESS_TOKEN_NOT_YET_VALID", "Access token nbf is invalid or in the future");
  }

  return {
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: parts[2],
    kid: header.kid,
    issuer,
    audience: payload.aud[0],
  };
}

async function readIssuerJwks(issuer) {
  const endpoint = `${issuer}/cdn-cgi/access/certs`;
  let response;
  try {
    response = await fetch(endpoint, {
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
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JWKS_BYTES) stop("ACCESS_JWKS_OVERSIZED", "Access signing-key response was oversized");
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
  const parsed = parseAccessToken(token, expectedAudience);
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

  let signature;
  try {
    signature = Buffer.from(parsed.signature, "base64url");
  } catch {
    stop("ACCESS_TOKEN_SIGNATURE_INVALID", "Access token signature encoding is invalid");
  }
  if (signature.length === 0) stop("ACCESS_TOKEN_SIGNATURE_INVALID", "Access token signature is empty");

  const valid = verify("RSA-SHA256", Buffer.from(parsed.signingInput, "ascii"), publicKey, signature);
  if (!valid) stop("ACCESS_TOKEN_SIGNATURE_INVALID", "Access token signature verification failed");
  return { issuer: parsed.issuer, audience: parsed.audience };
}

async function readAccessResponse(path, accessToken = "", codePrefix = "ACCESS") {
  const headers = { Accept: "application/json" };
  if (accessToken) headers["cf-access-token"] = accessToken;
  let response;
  try {
    response = await fetch(`https://${HOSTNAME}${path}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    stop(`${codePrefix}_READ`, "Control Access request failed");
  }
  return response;
}

async function assertPreActivationCanary(accessToken, codePrefix) {
  const response = await readAccessResponse(CANARY_PATH, accessToken, `${codePrefix}_CANARY`);
  if (response.status !== 404 && response.status !== 503) {
    stop(`${codePrefix}_CANARY_STATE`, "pre-activation canary must be absent or fail-closed disabled");
  }
}

async function assertProtectedHealth(accessToken, codePrefix) {
  const response = await readAccessResponse(HEALTH_PATH, accessToken, `${codePrefix}_HEALTH`);
  if (response.status !== 200) stop(`${codePrefix}_HEALTH_STATUS`, "protected health request did not return HTTP 200");
  let body;
  try {
    body = await response.json();
  } catch {
    stop(`${codePrefix}_HEALTH_JSON`, "protected health response was not JSON");
  }
  if (body?.status !== "ok" || body?.service !== WORKER_NAME) stop(`${codePrefix}_HEALTH_SHAPE`, "protected health response did not match");
}

async function assertActivatedCanary(accessToken, codePrefix) {
  const response = await readAccessResponse(CANARY_PATH, accessToken, `${codePrefix}_CANARY`);
  if (response.status !== 200 || !response.headers.get("cache-control")?.includes("no-store")) {
    stop(`${codePrefix}_CANARY_RESPONSE`, "authenticated canary did not return HTTP 200/no-store");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    stop(`${codePrefix}_CANARY_JSON`, "authenticated canary response was not JSON");
  }
  if (JSON.stringify(body) !== JSON.stringify({ status: "AUTHENTICATED" })) {
    stop(`${codePrefix}_CANARY_SHAPE`, "authenticated canary response leaked or differed from the reviewed shape");
  }
}

async function assertPublicAccessDenial(accessToken, codePrefix) {
  const missing = await readAccessResponse(CANARY_PATH, "", `${codePrefix}_MISSING_ACCESS`);
  if (missing.status >= 200 && missing.status < 300) {
    stop(`${codePrefix}_MISSING_ACCESS_ACCEPTED`, "missing Access credentials unexpectedly reached a successful canary response");
  }

  const forged = await readAccessResponse(CANARY_PATH, "not-a-valid-access-token", `${codePrefix}_FORGED_ACCESS`);
  if (forged.status >= 200 && forged.status < 300) {
    stop(`${codePrefix}_FORGED_ACCESS_ACCEPTED`, "forged Access credentials unexpectedly reached a successful canary response");
  }

  const valid = await readAccessResponse(CANARY_PATH, accessToken, `${codePrefix}_VALID_ACCESS_RECHECK`);
  if (valid.status !== 200) stop(`${codePrefix}_VALID_ACCESS_RECHECK`, "valid Access token no longer reaches the canary");
}

async function readPreActivationState(apiToken, accessToken, args, requireExpected, codePrefix) {
  const active = singleDeploymentVersion(await listDeployments(apiToken), codePrefix);
  if (requireExpected && (active.versionId !== args.currentVersion || active.deploymentId !== args.currentDeployment)) {
    stop(`${codePrefix}_ACTIVE_STATE`, "active Worker version/deployment moved from the authorized baseline");
  }
  assertPreActivationVersion(await versionDetail(apiToken, active.versionId), codePrefix);
  await assertSubdomainDisabled(apiToken, codePrefix);
  const domain = await readExactDomain(apiToken, requireExpected ? args.domainId : "", codePrefix);
  const queues = await assertQueueTopology(
    apiToken,
    requireExpected
      ? {
          mainQueueId: args.mainQueueId,
          mainConsumerId: args.mainConsumerId,
          dlqId: args.dlqId,
          dlqConsumerId: args.dlqConsumerId,
        }
      : {},
    codePrefix,
  );

  const parent = exactParentAccessApp(
    await listAccessApps(apiToken),
    requireExpected ? { appId: args.accessAppId, aud: args.accessAud } : {},
    codePrefix,
  );
  const identity = await verifyShortLivedAccessToken(accessToken, parent.aud);
  if (requireExpected && (identity.issuer !== args.issuer || identity.audience !== args.accessAud)) {
    stop(`${codePrefix}_ACCESS_IDENTITY`, "signed Access token identity moved from the authorized baseline");
  }
  await assertProtectedHealth(accessToken, codePrefix);
  await assertPreActivationCanary(accessToken, codePrefix);
  return { active, domain, queues, parent, identity };
}

function authorizationString(args) {
  return `${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${args.currentVersion} deployment ${args.currentDeployment} domain ${args.domainId} access ${args.accessAppId} aud ${args.accessAud} issuer ${args.issuer} mainq ${args.mainQueueId} mainc ${args.mainConsumerId} dlq ${args.dlqId} dlqc ${args.dlqConsumerId} inactive`;
}

function planOutput(args, state) {
  console.log("ACCESS_AUTH_CANARY_GATE=PLAN_PASS");
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("WORKER_DEPLOY=NOT_EXECUTED_IN_PLAN");
  console.log("ACCESS_APP_POLICY_MUTATION=NO");
  console.log("D1_MUTATION=NO");
  console.log("QUEUE_MUTATION=NO");
  console.log("GITHUB_PERMISSION_GROWTH=NO");
  console.log(`SOURCE_SHA=${args.sha}`);
  console.log(`CI_RUN_ID=${args.ci}`);
  console.log(`CURRENT_VERSION_ID=${state.active.versionId}`);
  console.log(`CURRENT_DEPLOYMENT_ID=${state.active.deploymentId}`);
  console.log(`DOMAIN_ID=${state.domain.id}`);
  console.log(`PARENT_ACCESS_APP_ID=${state.parent.id}`);
  console.log(`PARENT_ACCESS_APP_AUD=${state.identity.audience}`);
  console.log(`ACCESS_ISSUER=${state.identity.issuer}`);
  console.log(`MAIN_QUEUE_ID=${state.queues.main.queue_id}`);
  console.log(`MAIN_QUEUE_CONSUMER_ID=${state.queues.mainConsumer.consumer_id}`);
  console.log(`DLQ_ID=${state.queues.dlq.queue_id}`);
  console.log(`DLQ_CONSUMER_ID=${state.queues.dlqConsumer.consumer_id}`);
  console.log("PREACTIVATION_CANARY=INACTIVE_FAIL_CLOSED");
  console.log("ACCESS_TOKEN_SIGNATURE=VERIFIED_RS256_JWKS");
  console.log("DEPLOY_VAR_SOURCE=AUTHORIZED_RUNTIME_ONLY");
  console.log(
    `OWNER_AUTHORIZATION=${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${state.active.versionId} deployment ${state.active.deploymentId} domain ${state.domain.id} access ${state.parent.id} aud ${state.identity.audience} issuer ${state.identity.issuer} mainq ${state.queues.main.queue_id} mainc ${state.queues.mainConsumer.consumer_id} dlq ${state.queues.dlq.queue_id} dlqc ${state.queues.dlqConsumer.consumer_id} inactive`,
  );
  console.log("NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES");
}

async function plan(args) {
  assertBaseInputs(args.sha, args.ci);
  assertRepo(args.sha);
  await assertCi(args.sha, args.ci);
  await assertSourceConfig();
  const { apiToken, accessToken } = requiredEnvironment();
  const state = await readPreActivationState(apiToken, accessToken, args, false, "PLAN");
  planOutput(args, state);
}

function validateApplyArgs(args) {
  assertBaseInputs(args.sha, args.ci);
  assertUuid(args.currentVersion, "CURRENT_VERSION_INVALID", "current Worker version id");
  assertUuid(args.currentDeployment, "CURRENT_DEPLOYMENT_INVALID", "current Worker deployment id");
  assertOpaqueId(args.domainId, "DOMAIN_ID_INVALID", "Custom Domain id");
  assertUuid(args.accessAppId, "ACCESS_APP_ID_INVALID", "parent Access application id");
  assertAudience(args.accessAud);
  normalizeIssuer(args.issuer);
  assertOpaqueId(args.mainQueueId, "MAIN_QUEUE_ID_INVALID", "main Queue id");
  assertOpaqueId(args.mainConsumerId, "MAIN_CONSUMER_ID_INVALID", "main Queue consumer id");
  assertOpaqueId(args.dlqId, "DLQ_ID_INVALID", "DLQ id");
  assertOpaqueId(args.dlqConsumerId, "DLQ_CONSUMER_ID_INVALID", "DLQ consumer id");
}

function samePreActivationIdentity(a, b) {
  return (
    a.active.versionId === b.active.versionId &&
    a.active.deploymentId === b.active.deploymentId &&
    a.domain.id === b.domain.id &&
    a.parent.id === b.parent.id &&
    a.identity.audience === b.identity.audience &&
    a.identity.issuer === b.identity.issuer &&
    a.queues.main.queue_id === b.queues.main.queue_id &&
    a.queues.mainConsumer.consumer_id === b.queues.mainConsumer.consumer_id &&
    a.queues.dlq.queue_id === b.queues.dlq.queue_id &&
    a.queues.dlqConsumer.consumer_id === b.queues.dlqConsumer.consumer_id
  );
}

function deployVars(issuer, audience) {
  return [
    ["GITHUB_APP_CLIENT_ID", APP_CLIENT_ID],
    ["GITHUB_APP_INSTALLATION_ID", INSTALLATION_ID],
    ["CONTROL_LIVE_READ_ENABLED", "true"],
    ["CONTROL_WEBHOOK_RUNTIME_ENABLED", "true"],
    ["CONTROL_ACCESS_AUTH_CANARY_ENABLED", "true"],
    ["CONTROL_ACCESS_ISSUER", issuer],
    ["CONTROL_ACCESS_AUDIENCE", audience],
  ];
}

async function apply(args) {
  validateApplyArgs(args);
  assertRepo(args.sha);
  await assertCi(args.sha, args.ci);
  await assertSourceConfig();
  const { apiToken, accessToken } = requiredEnvironment();

  const first = await readPreActivationState(apiToken, accessToken, args, true, "PREWRITE");
  const expectedAuthorization = authorizationString(args);
  if ((process.env.CONTROL_OWNER_AUTHORIZATION ?? "") !== expectedAuthorization) {
    stop("OWNER_AUTHORIZATION_INVALID", "owner authorization did not exactly match the current prewrite state");
  }

  run("npm", ["run", "check"], { env: cleanEnv() });
  const second = await readPreActivationState(apiToken, accessToken, args, true, "RECHECK");
  if (!samePreActivationIdentity(first, second)) {
    stop("PREWRITE_STATE_MOVED", "production state moved between preflight and the final prewrite recheck");
  }

  const deployArgs = ["deploy", "--strict"];
  for (const [name, value] of deployVars(args.issuer, args.accessAud)) {
    deployArgs.push("--var", `${name}:${value}`);
  }

  deployStarted = true;
  console.log("DEPLOY_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  run(wranglerPath(), deployArgs, { inherit: true, env: childEnvironment(apiToken) });

  const active = singleDeploymentVersion(await listDeployments(apiToken), "POSTWRITE");
  if (active.versionId === args.currentVersion || active.deploymentId === args.currentDeployment) {
    stop("POSTWRITE_DEPLOYMENT_UNCHANGED", "Worker deploy did not produce a new active version/deployment");
  }
  assertActivatedVersion(await versionDetail(apiToken, active.versionId), args.issuer, args.accessAud, "POSTWRITE");
  await assertSubdomainDisabled(apiToken, "POSTWRITE");
  const domain = await readExactDomain(apiToken, args.domainId, "POSTWRITE");
  const queues = await assertQueueTopology(
    apiToken,
    {
      mainQueueId: args.mainQueueId,
      mainConsumerId: args.mainConsumerId,
      dlqId: args.dlqId,
      dlqConsumerId: args.dlqConsumerId,
    },
    "POSTWRITE",
  );
  const parent = exactParentAccessApp(
    await listAccessApps(apiToken),
    { appId: args.accessAppId, aud: args.accessAud },
    "POSTWRITE",
  );
  const identity = await verifyShortLivedAccessToken(accessToken, parent.aud);
  if (identity.issuer !== args.issuer || identity.audience !== args.accessAud) {
    stop("POSTWRITE_ACCESS_IDENTITY", "Access identity proof changed after deployment");
  }

  await assertProtectedHealth(accessToken, "POSTWRITE");
  await assertActivatedCanary(accessToken, "POSTWRITE");
  await assertPublicAccessDenial(accessToken, "POSTWRITE");

  console.log("ACCESS_AUTH_CANARY_GATE=PASS");
  console.log(`NEW_VERSION_ID=${active.versionId}`);
  console.log(`NEW_DEPLOYMENT_ID=${active.deploymentId}`);
  console.log(`DOMAIN_ID=${domain.id}`);
  console.log(`PARENT_ACCESS_APP_ID=${parent.id}`);
  console.log(`PARENT_ACCESS_APP_AUD=${identity.audience}`);
  console.log(`ACCESS_ISSUER=${identity.issuer}`);
  console.log(`MAIN_QUEUE_ID=${queues.main.queue_id}`);
  console.log(`MAIN_QUEUE_CONSUMER_ID=${queues.mainConsumer.consumer_id}`);
  console.log(`DLQ_ID=${queues.dlq.queue_id}`);
  console.log(`DLQ_CONSUMER_ID=${queues.dlqConsumer.consumer_id}`);
  console.log("ACCESS_AUTH_CANARY=AUTHENTICATED");
  console.log("MISSING_ACCESS_SUCCESS=REJECTED");
  console.log("FORGED_ACCESS_SUCCESS=REJECTED");
  console.log("ACCESS_APP_POLICY_MUTATION=NO");
  console.log("D1_MUTATION=NO");
  console.log("QUEUE_MUTATION=NO");
  console.log("GITHUB_PERMISSION_GROWTH=NO");
  console.log("AUTHORIZATION_STATUS=CONSUMED_SUCCESSFULLY");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") await plan(args);
  else await apply(args);
}

await main().catch(() => {
  if (deployStarted) {
    console.error("AUTHORIZATION_STATUS=CONSUMED_RECONCILIATION_REQUIRED");
    console.error("NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES");
  } else {
    console.error("AUTHORIZATION_STATUS=NOT_CONSUMED");
  }
  if (!process.exitCode) process.exitCode = 1;
});
