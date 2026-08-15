#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  accessApplicationPublicUris,
  assertExactWebhookAccessApplication,
  exactParentAccessApplication,
  exactWebhookAccessApplications,
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
  cfWrite,
  listDeployments,
  listDomains,
  run,
  singleDeploymentVersion,
  stop,
  versionDetail,
  wranglerPath,
} from "./cloudflare-ui-rollout-shared.mjs";

const AUTH_PREFIX = `authorize Phase 2 webhook reconciliation ${HOSTNAME} `;
const APP_CLIENT_ID = "Iv23likDoFtVeWBJfdFS";
const INSTALLATION_ID = "153121564";
const WEBHOOK_SECRET_NAME = "GITHUB_WEBHOOK_SECRET";
const MAIN_QUEUE_NAME = "rozkalns-control-reconciliation";
const DLQ_NAME = "rozkalns-control-reconciliation-dlq";
const WEBHOOK_PATH = "/api/github/webhook";
const OBSERVABILITY_PATH = "/api/github/webhook-deliveries";
const WEBHOOK_ACCESS_DOMAIN = `${HOSTNAME}${WEBHOOK_PATH}`;
const WEBHOOK_ACCESS_APP_NAME = "Rozkalns Control GitHub webhook";
const WEBHOOK_ACCESS_POLICY_NAME = "Bypass GitHub webhook HMAC endpoint";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EXPECTED_DELIVERY_COLUMNS = [
  "delivery_id",
  "repository",
  "project_id",
  "event_name",
  "message_version",
  "state",
  "attempt_count",
  "received_at",
  "enqueued_at",
  "processing_started_at",
  "last_attempt_at",
  "updated_at",
  "completed_at",
  "dead_lettered_at",
  "last_error_code",
];

let writeStarted = false;

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
    mainQueueId: "",
    mainConsumerId: "",
    dlqId: "",
    dlqConsumerId: "",
    deliveryCount: "",
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
    else if (key === "--expected-main-queue-id") out.mainQueueId = argv[++index] ?? "";
    else if (key === "--expected-main-consumer-id") out.mainConsumerId = argv[++index] ?? "";
    else if (key === "--expected-dlq-id") out.dlqId = argv[++index] ?? "";
    else if (key === "--expected-dlq-consumer-id") out.dlqConsumerId = argv[++index] ?? "";
    else if (key === "--expected-delivery-count") out.deliveryCount = argv[++index] ?? "";
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
  if (!AUDIENCE_PATTERN.test(value)) stop("ACCESS_AUD_INVALID", "expected Access audience is invalid");
}

function assertDeliveryCount(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    stop("DELIVERY_COUNT_INVALID", "expected delivery count must be a non-negative integer");
  }
}

function requiredAccountAndToken() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (account !== ACCOUNT_ID) stop("ACCOUNT_ID_INVALID", "Cloudflare account does not match reviewed production account");
  if (!apiToken) stop("API_TOKEN_REQUIRED", "temporary Cloudflare token is required");
  return apiToken;
}

function assertPlainTextBinding(detail, name, expected, codePrefix) {
  const bindings = detail?.resources?.bindings;
  if (!Array.isArray(bindings)) stop(`${codePrefix}_BINDINGS_INVALID`, "version bindings were not available");
  const matches = bindings.filter((binding) => binding?.name === name && binding?.type === "plain_text");
  if (matches.length !== 1 || matches[0]?.text !== expected) {
    stop(`${codePrefix}_${name}_BINDING`, `${name} plain-text binding did not match reviewed value`);
  }
}

function assertSecretBinding(detail, name, codePrefix) {
  const bindings = detail?.resources?.bindings;
  if (!Array.isArray(bindings)) stop(`${codePrefix}_BINDINGS_INVALID`, "version bindings were not available");
  const matches = bindings.filter(
    (binding) => binding?.name === name && (binding?.type === "secret_text" || binding?.type === "secret_key"),
  );
  if (matches.length !== 1) stop(`${codePrefix}_${name}_SECRET`, `${name} secret binding was not uniquely present`);
}

function assertActivatedVersion(detail, codePrefix) {
  assertRequiredBindings(detail, codePrefix);
  assertPlainTextBinding(detail, "GITHUB_APP_CLIENT_ID", APP_CLIENT_ID, codePrefix);
  assertPlainTextBinding(detail, "GITHUB_APP_INSTALLATION_ID", INSTALLATION_ID, codePrefix);
  assertPlainTextBinding(detail, "CONTROL_LIVE_READ_ENABLED", "true", codePrefix);
  assertPlainTextBinding(detail, "CONTROL_WEBHOOK_RUNTIME_ENABLED", "true", codePrefix);
  assertSecretBinding(detail, WEBHOOK_SECRET_NAME, codePrefix);
}

async function assertReconciliationSourceConfig() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) stop("WRANGLER_PIN_INVALID", "repository Wrangler pin changed");

  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  if (config?.name !== WORKER_NAME) stop("WORKER_NAME_INVALID", "Worker target changed");
  if (config?.workers_dev !== false) stop("WORKERS_DEV_NOT_DISABLED", "workers.dev must remain disabled");
  if (config?.preview_urls !== false) stop("PREVIEW_URLS_NOT_DISABLED", "Preview URLs must remain disabled");
  if (config?.vars?.GITHUB_APP_CLIENT_ID !== APP_CLIENT_ID) stop("APP_CLIENT_ID_INVALID", "GitHub App client id changed");
  if (config?.vars?.GITHUB_APP_INSTALLATION_ID !== INSTALLATION_ID) stop("INSTALLATION_ID_INVALID", "GitHub App installation id changed");
  if (config?.vars?.CONTROL_LIVE_READ_ENABLED !== "true") stop("LIVE_READ_NOT_ENABLED", "live read must remain enabled");
  if (config?.vars?.CONTROL_WEBHOOK_RUNTIME_ENABLED !== "true") stop("WEBHOOK_RUNTIME_NOT_ENABLED", "webhook runtime must remain enabled");

  const requiredSecrets = config?.secrets?.required;
  if (!Array.isArray(requiredSecrets) || JSON.stringify(requiredSecrets) !== JSON.stringify(["GITHUB_APP_PRIVATE_KEY_PEM", WEBHOOK_SECRET_NAME])) {
    stop("SECRET_CONTRACT_INVALID", "required secret names changed");
  }

  const d1 = Array.isArray(config?.d1_databases) ? config.d1_databases : [];
  if (
    d1.length !== 1 ||
    d1[0]?.binding !== "CONTROL_DB" ||
    d1[0]?.database_name !== DB_NAME ||
    d1[0]?.database_id !== DB_ID ||
    d1[0]?.migrations_dir !== "migrations"
  ) stop("D1_BINDING_INVALID", "production D1 binding changed");

  const producers = config?.queues?.producers;
  if (!Array.isArray(producers) || producers.length !== 1 || producers[0]?.binding !== "RECONCILIATION_QUEUE" || producers[0]?.queue !== MAIN_QUEUE_NAME) {
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
    stop("QUEUE_CONSUMER_CONFIG_INVALID", "reviewed Queue consumer policy changed");
  }

  if (
    config?.assets?.directory !== "./dist/client" ||
    config?.assets?.not_found_handling !== "single-page-application" ||
    JSON.stringify(config?.assets?.run_worker_first) !== JSON.stringify(["/api/*"])
  ) stop("ASSETS_CONFIG_INVALID", "reviewed SPA/API routing changed");

  for (const forbidden of ["route", "routes", "triggers", "custom_domain", "custom_domains"]) {
    if (Object.hasOwn(config, forbidden)) stop("SOURCE_ROUTING_PRESENT", `${forbidden} is forbidden in reconciliation source`);
  }

  const version = run(wranglerPath(), ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== WRANGLER_VERSION) stop("WRANGLER_VERSION_INVALID", "installed Wrangler version changed");
}

function accessAudience(accessToken, codePrefix) {
  try {
    return readAccessTokenApplicationAudience(accessToken);
  } catch (error) {
    stop(`${codePrefix}_${error?.code ?? "ACCESS_TOKEN_IDENTITY"}`, error instanceof Error ? error.message : "Access token identity proof failed");
  }
}

async function listAccessApps(apiToken) {
  const apps = await cfGet(apiToken, "/access/apps");
  if (!Array.isArray(apps)) stop("ACCESS_APP_INVENTORY_INVALID", "Access application inventory was not an array");
  return apps;
}

function exactParentAccessApp(apps, audience, expectedId = "", codePrefix = "ACCESS") {
  try {
    return exactParentAccessApplication(apps, audience, expectedId);
  } catch (error) {
    stop(`${codePrefix}_${error?.code ?? "PARENT_APP"}`, error instanceof Error ? error.message : "parent Access application proof failed");
  }
}

function assertWebhookAccessAbsent(apps, codePrefix) {
  let matches;
  try {
    matches = exactWebhookAccessApplications(apps, WEBHOOK_ACCESS_DOMAIN, WEBHOOK_ACCESS_APP_NAME);
  } catch (error) {
    stop(`${codePrefix}_${error?.code ?? "WEBHOOK_APP"}`, error instanceof Error ? error.message : "webhook Access application proof failed");
  }
  if (matches.length !== 0) stop(`${codePrefix}_WEBHOOK_APP_PRESENT`, "webhook Access application already exists; reconcile current state instead of replaying this continuation");
}

async function assertActivatedAccess(apiToken, audience, expectedParentId, expectedWebhookAppId, expectedPolicyId, codePrefix) {
  const apps = await listAccessApps(apiToken);
  const parent = exactParentAccessApp(apps, audience, expectedParentId, `${codePrefix}_PARENT`);
  let webhookMatches;
  try {
    webhookMatches = exactWebhookAccessApplications(apps, WEBHOOK_ACCESS_DOMAIN, WEBHOOK_ACCESS_APP_NAME).filter((app) => app?.id === expectedWebhookAppId);
  } catch (error) {
    stop(`${codePrefix}_${error?.code ?? "WEBHOOK_APP"}`, error instanceof Error ? error.message : "webhook Access application proof failed");
  }
  if (webhookMatches.length !== 1) stop(`${codePrefix}_WEBHOOK_APP`, "exact webhook Access application was not uniquely proven");
  const webhook = webhookMatches[0];
  try {
    assertExactWebhookAccessApplication(webhook, expectedWebhookAppId, WEBHOOK_ACCESS_DOMAIN, WEBHOOK_ACCESS_APP_NAME);
  } catch (error) {
    stop(`${codePrefix}_${error?.code ?? "WEBHOOK_APP_SHAPE"}`, error instanceof Error ? error.message : "webhook Access application shape changed");
  }

  const policies = await cfGet(apiToken, `/access/apps/${encodeURIComponent(webhook.id)}/policies`);
  if (!Array.isArray(policies)) stop(`${codePrefix}_POLICY_INVENTORY`, "webhook Access policy inventory was not an array");
  const matches = policies.filter((policy) => policy?.id === expectedPolicyId);
  if (matches.length !== 1) stop(`${codePrefix}_POLICY`, "exact webhook bypass policy was not uniquely proven");
  const policy = matches[0];
  const everyone = Array.isArray(policy?.include) && policy.include.length === 1 && policy.include[0]?.everyone;
  if (policy?.name !== WEBHOOK_ACCESS_POLICY_NAME || policy?.decision !== "bypass" || policy?.precedence !== 1 || !everyone) {
    stop(`${codePrefix}_POLICY_SHAPE`, "webhook Access bypass policy does not match reviewed exact-path policy");
  }
  return { parent, webhook, policy };
}

async function targetDomains(apiToken) {
  const domains = await cfGet(apiToken, `/workers/domains?hostname=${encodeURIComponent(HOSTNAME)}`);
  if (!Array.isArray(domains)) stop("TARGET_DOMAIN_INVENTORY_INVALID", "target domain inventory was not an array");
  return domains;
}

function exactDomain(domains, expectedDomainId = "", codePrefix = "DOMAIN") {
  const matches = domains.filter(
    (domain) => domain?.hostname === HOSTNAME && domain?.service === WORKER_NAME && (expectedDomainId === "" || domain?.id === expectedDomainId),
  );
  if (matches.length !== 1) stop(`${codePrefix}_STATE`, "exact Worker custom domain was not uniquely proven");
  const domain = matches[0];
  if (typeof domain?.id !== "string" || domain.id.length === 0) stop(`${codePrefix}_ID`, "domain id missing");
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

async function assertActivatedQueues(apiToken, expected = {}, codePrefix = "QUEUE") {
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

async function d1ReadOnlyQuery(apiToken, sql) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    stop("D1_READ_FAILED", "D1 read-only query request failed");
  }
  if (!response.ok) stop("D1_READ_FAILED", `D1 read-only query returned HTTP ${response.status}`);
  let payload;
  try { payload = await response.json(); } catch { stop("D1_READ_INVALID", "D1 read-only query did not return JSON"); }
  if (payload?.success !== true || !Array.isArray(payload?.result) || payload.result.length !== 1) stop("D1_READ_INVALID", "D1 read-only query response was unsuccessful or ambiguous");
  const result = payload.result[0];
  if (result?.success !== true || !Array.isArray(result?.results)) stop("D1_READ_INVALID", "D1 read-only query result was unsuccessful");
  if (result?.meta?.changed_db === true || Number(result?.meta?.changes ?? 0) !== 0) stop("D1_READ_MUTATED", "read-only D1 preflight unexpectedly reported a mutation");
  return result.results;
}

async function readDeliveryBaseline(apiToken) {
  const columns = await d1ReadOnlyQuery(apiToken, "PRAGMA table_info(webhook_deliveries)");
  if (JSON.stringify(columns.map((row) => row?.name)) !== JSON.stringify(EXPECTED_DELIVERY_COLUMNS)) stop("D1_SCHEMA_MISMATCH", "webhook_deliveries schema does not match reviewed migration");
  const rows = await d1ReadOnlyQuery(apiToken, "SELECT COUNT(*) AS count FROM webhook_deliveries");
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.count) || rows[0].count < 0) stop("D1_DELIVERY_COUNT_INVALID", "webhook delivery baseline count was invalid");
  return rows[0].count;
}

async function readAccessJson(path, accessToken, codePrefix) {
  let response;
  try {
    response = await fetch(`https://${HOSTNAME}${path}`, {
      headers: { Accept: "application/json", "cf-access-token": accessToken },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    stop(`${codePrefix}_READ`, "Access-authenticated request failed");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) stop(`${codePrefix}_MEDIA_TYPE`, "Access-authenticated response must be JSON");
  let body;
  try { body = await response.json(); } catch { stop(`${codePrefix}_JSON`, "Access-authenticated response JSON could not be parsed"); }
  return { response, body };
}

async function assertProtectedHealth(accessToken, codePrefix) {
  const { response, body } = await readAccessJson("/api/health", accessToken, `${codePrefix}_HEALTH`);
  if (response.status !== 200 || body?.status !== "ok" || body?.service !== WORKER_NAME) {
    stop(`${codePrefix}_HEALTH_CANARY`, "protected Control health canary did not match");
  }
}

async function assertObservabilityReady(accessToken, codePrefix) {
  const { response, body } = await readAccessJson(OBSERVABILITY_PATH, accessToken, `${codePrefix}_OBSERVABILITY`);
  if (response.status !== 200 || !response.headers.get("cache-control")?.includes("no-store")) {
    stop(`${codePrefix}_OBSERVABILITY_RESPONSE`, "webhook delivery observability is not ready/no-store");
  }
  if (
    typeof body?.status !== "string" ||
    typeof body?.totalDeliveries !== "number" ||
    typeof body?.diagnosticsTruncated !== "boolean" ||
    !Array.isArray(body?.diagnostics) ||
    body.diagnostics.length > 50
  ) stop(`${codePrefix}_OBSERVABILITY_SHAPE`, "webhook delivery observability shape was invalid");
  return body;
}

async function assertSignedPing(secret, codePrefix, accessToken = "") {
  const payload = JSON.stringify({ zen: "Rozkalns Control reconciliation canary", hook_id: 160 });
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-GitHub-Delivery": `rozkalns-control-reconcile-${codePrefix.toLowerCase()}`,
    "X-GitHub-Event": "ping",
    "X-Hub-Signature-256": `sha256=${signature}`,
  };
  if (accessToken) headers["cf-access-token"] = accessToken;

  let response;
  try {
    response = await fetch(`https://${WEBHOOK_ACCESS_DOMAIN}`, {
      method: "POST",
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    stop(`${codePrefix}_PING_READ`, "signed webhook ping request failed");
  }
  if (!response.headers.get("cache-control")?.includes("no-store")) stop(`${codePrefix}_PING_CACHE`, "signed webhook ping response must be no-store");
  let body;
  try { body = await response.json(); } catch { stop(`${codePrefix}_PING_JSON`, "signed webhook ping did not return JSON"); }
  if (response.status !== 200 || body?.status !== "PING") stop(`${codePrefix}_PING_RESULT`, "signed webhook ping did not prove the HMAC endpoint");
}

async function readPartialState(apiToken, audience, args, requireExpected, codePrefix) {
  const active = singleDeploymentVersion(await listDeployments(apiToken), codePrefix);
  if (requireExpected && (active.versionId !== args.currentVersion || active.deploymentId !== args.currentDeployment)) {
    stop(`${codePrefix}_ACTIVE_STATE`, "active Worker version/deployment moved from authorized reconciliation baseline");
  }
  assertActivatedVersion(await versionDetail(apiToken, active.versionId), codePrefix);
  await assertSubdomainDisabled(apiToken, codePrefix);
  const domain = await readExactDomain(apiToken, requireExpected ? args.domainId : "", codePrefix);

  const apps = await listAccessApps(apiToken);
  const parent = exactParentAccessApp(apps, audience, requireExpected ? args.accessAppId : "", `${codePrefix}_PARENT`);
  if (requireExpected && parent.aud !== args.accessAud) stop(`${codePrefix}_ACCESS_AUD`, "parent Access application audience moved from authorized baseline");
  assertWebhookAccessAbsent(apps, codePrefix);

  const queues = await assertActivatedQueues(
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

  const deliveryCount = await readDeliveryBaseline(apiToken);
  if (requireExpected && deliveryCount !== Number(args.deliveryCount)) {
    stop(`${codePrefix}_DELIVERY_COUNT`, "D1 delivery baseline moved from authorized reconciliation value");
  }

  return { active, domain, parent, queues, deliveryCount };
}

function authorizationString(args) {
  return `${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${args.currentVersion} deployment ${args.currentDeployment} domain ${args.domainId} access ${args.accessAppId} aud ${args.accessAud} mainq ${args.mainQueueId} mainc ${args.mainConsumerId} dlq ${args.dlqId} dlqc ${args.dlqConsumerId} deliveries ${args.deliveryCount} webhook absent`;
}

function planOutput(args, state, audience) {
  console.log("WEBHOOK_QUEUE_RECONCILIATION_GATE=PLAN_PASS");
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("D1_QUERY_MODE=READ_ONLY_SQL");
  console.log(`SOURCE_SHA=${args.sha}`);
  console.log(`CI_RUN_ID=${args.ci}`);
  console.log(`CURRENT_VERSION_ID=${state.active.versionId}`);
  console.log(`CURRENT_DEPLOYMENT_ID=${state.active.deploymentId}`);
  console.log(`DOMAIN_ID=${state.domain.id}`);
  console.log(`PARENT_ACCESS_APP_ID=${state.parent.id}`);
  console.log(`PARENT_ACCESS_APP_AUD=${audience}`);
  console.log(`MAIN_QUEUE_ID=${state.queues.main.queue_id}`);
  console.log(`MAIN_QUEUE_CONSUMER_ID=${state.queues.mainConsumer.consumer_id}`);
  console.log(`DLQ_ID=${state.queues.dlq.queue_id}`);
  console.log(`DLQ_CONSUMER_ID=${state.queues.dlqConsumer.consumer_id}`);
  console.log(`WEBHOOK_DELIVERY_BASELINE=${state.deliveryCount}`);
  console.log("WORKER_QUEUE_RUNTIME=ACTIVATED_AND_VERIFIED");
  console.log("TARGET_WEBHOOK_ACCESS_APP=ABSENT");
  console.log("RECONCILIATION_WRITE_SCOPE=ACCESS_APP_AND_POLICY_ONLY");
  console.log("QUEUE_CREATE=FORBIDDEN");
  console.log("WORKER_DEPLOY=FORBIDDEN");
  console.log("GITHUB_PERMISSION_GROWTH=NO");
  console.log(`OWNER_AUTHORIZATION=${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${state.active.versionId} deployment ${state.active.deploymentId} domain ${state.domain.id} access ${state.parent.id} aud ${audience} mainq ${state.queues.main.queue_id} mainc ${state.queues.mainConsumer.consumer_id} dlq ${state.queues.dlq.queue_id} dlqc ${state.queues.dlqConsumer.consumer_id} deliveries ${state.deliveryCount} webhook absent`);
  console.log("NO_BLIND_RETRY_AFTER_WRITE_STARTED=YES");
}

async function plan(args) {
  assertBaseInputs(args.sha, args.ci);
  const apiToken = requiredAccountAndToken();
  const accessToken = process.env.CONTROL_ACCESS_TOKEN ?? "";
  if (!accessToken) stop("ACCESS_TOKEN_REQUIRED", "short-lived Cloudflare Access user token is required");

  assertRepo(args.sha);
  await assertReconciliationSourceConfig();
  await assertCi(args.sha, args.ci);
  run("npm", ["run", "check"], { inherit: true });
  await assertProtectedHealth(accessToken, "PLAN");
  const audience = accessAudience(accessToken, "PLAN");
  const state = await readPartialState(apiToken, audience, args, false, "PLAN");
  const observability = await assertObservabilityReady(accessToken, "PLAN");
  if (observability.totalDeliveries !== state.deliveryCount) stop("PLAN_OBSERVABILITY_COUNT", "observability and D1 delivery totals disagreed");
  planOutput(args, state, audience);
}

async function apply(args) {
  assertBaseInputs(args.sha, args.ci);
  assertUuid(args.currentVersion, "CURRENT_VERSION_ID_INVALID", "current Worker version id");
  assertUuid(args.currentDeployment, "CURRENT_DEPLOYMENT_ID_INVALID", "current Worker deployment id");
  assertOpaqueId(args.domainId, "DOMAIN_ID_INVALID", "custom domain id");
  assertUuid(args.accessAppId, "ACCESS_APP_ID_INVALID", "parent Access app id");
  assertAudience(args.accessAud);
  assertOpaqueId(args.mainQueueId, "MAIN_QUEUE_ID_INVALID", "main Queue id");
  assertOpaqueId(args.mainConsumerId, "MAIN_CONSUMER_ID_INVALID", "main Queue consumer id");
  assertOpaqueId(args.dlqId, "DLQ_ID_INVALID", "DLQ id");
  assertOpaqueId(args.dlqConsumerId, "DLQ_CONSUMER_ID_INVALID", "DLQ consumer id");
  assertDeliveryCount(args.deliveryCount);

  const apiToken = requiredAccountAndToken();
  const accessToken = process.env.CONTROL_ACCESS_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";
  const webhookSecret = process.env.CONTROL_GITHUB_WEBHOOK_SECRET ?? "";
  if (!accessToken) stop("ACCESS_TOKEN_REQUIRED", "short-lived Cloudflare Access user token is required");
  if (webhookSecret.length < 32 || webhookSecret.length > 512) stop("WEBHOOK_SECRET_INVALID", "webhook secret must be high-entropy and 32..512 characters");
  if (authorization !== authorizationString(args)) stop("OWNER_AUTHORIZATION_INVALID", "owner authorization does not match exact fresh reconciliation baseline");

  assertRepo(args.sha);
  await assertReconciliationSourceConfig();
  await assertCi(args.sha, args.ci);
  run("npm", ["run", "check"], { inherit: true });
  await assertProtectedHealth(accessToken, "PREWRITE");
  const audience = accessAudience(accessToken, "PREWRITE");
  if (audience !== args.accessAud) stop("PREWRITE_ACCESS_AUD", "Access token audience does not match authorized reconciliation baseline");
  let state = await readPartialState(apiToken, audience, args, true, "PREWRITE");
  let observability = await assertObservabilityReady(accessToken, "PREWRITE");
  if (observability.totalDeliveries !== state.deliveryCount) stop("PREWRITE_OBSERVABILITY_COUNT", "observability and D1 delivery totals disagreed");

  // Prove the saved webhook secret already matches the deployed Worker before any
  // reconciliation write. Ping is side-effect-free by runtime contract.
  await assertSignedPing(webhookSecret, "PREWRITE", accessToken);

  assertRepo(args.sha);
  await assertReconciliationSourceConfig();
  await assertCi(args.sha, args.ci);
  await assertProtectedHealth(accessToken, "FINAL_PREWRITE");
  const finalAudience = accessAudience(accessToken, "FINAL_PREWRITE");
  if (finalAudience !== audience) stop("FINAL_PREWRITE_ACCESS_AUDIENCE_CHANGED", "Access token audience changed during reconciliation preflight");
  state = await readPartialState(apiToken, audience, args, true, "FINAL_PREWRITE");
  observability = await assertObservabilityReady(accessToken, "FINAL_PREWRITE");
  if (observability.totalDeliveries !== state.deliveryCount) stop("FINAL_PREWRITE_OBSERVABILITY_COUNT", "observability and D1 delivery totals disagreed");

  console.log("WRITE_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("NO_BLIND_RETRY_IF_STOP_AFTER_WRITE_STARTED=YES");
  writeStarted = true;

  const accessApp = await cfWrite(apiToken, "/access/apps", "POST", {
    name: WEBHOOK_ACCESS_APP_NAME,
    type: "self_hosted",
    domain: WEBHOOK_ACCESS_DOMAIN,
    destinations: [{ type: "public", uri: WEBHOOK_ACCESS_DOMAIN }],
    app_launcher_visible: false,
  });
  if (!UUID_PATTERN.test(accessApp?.id ?? "")) stop("ACCESS_WEBHOOK_APP_CREATE", "created webhook Access app id was invalid");
  if (!accessApplicationPublicUris(accessApp).includes(WEBHOOK_ACCESS_DOMAIN)) stop("ACCESS_WEBHOOK_APP_CREATE_DESTINATION", "created webhook Access app did not return the exact reviewed public destination");

  const bypassPolicy = await cfWrite(apiToken, `/access/apps/${encodeURIComponent(accessApp.id)}/policies`, "POST", {
    name: WEBHOOK_ACCESS_POLICY_NAME,
    decision: "bypass",
    precedence: 1,
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  });
  if (!UUID_PATTERN.test(bypassPolicy?.id ?? "")) stop("ACCESS_WEBHOOK_POLICY_CREATE", "created bypass policy id was invalid");

  await assertActivatedAccess(apiToken, audience, args.accessAppId, accessApp.id, bypassPolicy.id, "POST_VERIFY");
  const postQueues = await assertActivatedQueues(
    apiToken,
    {
      mainQueueId: args.mainQueueId,
      mainConsumerId: args.mainConsumerId,
      dlqId: args.dlqId,
      dlqConsumerId: args.dlqConsumerId,
    },
    "POST_VERIFY",
  );
  const active = singleDeploymentVersion(await listDeployments(apiToken), "POST_VERIFY");
  if (active.versionId !== args.currentVersion || active.deploymentId !== args.currentDeployment) stop("POST_VERIFY_ACTIVE_STATE", "Worker version/deployment changed during Access-only reconciliation");
  await assertSubdomainDisabled(apiToken, "POST_VERIFY");
  const domain = await readExactDomain(apiToken, args.domainId, "POST_VERIFY");
  await assertPublicState(webhookSecret, accessToken, apiToken, audience, args.deliveryCount);

  console.log("WEBHOOK_QUEUE_RECONCILIATION_GATE=PASS");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log(`ACTIVE_VERSION_ID=${active.versionId}`);
  console.log(`ACTIVE_DEPLOYMENT_ID=${active.deploymentId}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log(`CUSTOM_DOMAIN=${domain.hostname}`);
  console.log(`DOMAIN_ID=${domain.id}`);
  console.log(`MAIN_QUEUE_ID=${postQueues.main.queue_id}`);
  console.log(`MAIN_QUEUE_CONSUMER_ID=${postQueues.mainConsumer.consumer_id}`);
  console.log(`DLQ_ID=${postQueues.dlq.queue_id}`);
  console.log(`DLQ_CONSUMER_ID=${postQueues.dlqConsumer.consumer_id}`);
  console.log(`WEBHOOK_ACCESS_APP_ID=${accessApp.id}`);
  console.log(`WEBHOOK_ACCESS_POLICY_ID=${bypassPolicy.id}`);
  console.log(`PARENT_ACCESS_APP_AUD=${audience}`);
  console.log("PUBLIC_SIGNED_PING=PASS");
  console.log("ACCESS_PARENT_PROTECTION=PRESERVED");
  console.log("ACCESS_WEBHOOK_PATH_BYPASS=EXACT_PATH_ONLY");
  console.log("QUEUE_CREATE=NOT_PERFORMED");
  console.log("WORKER_DEPLOY=NOT_PERFORMED");
  console.log("GITHUB_PERMISSION_GROWTH=NO");
  console.log("GITHUB_APP_WEBHOOK_CONFIGURATION_REQUIRED=YES");
  console.log(`GITHUB_APP_WEBHOOK_URL=https://${WEBHOOK_ACCESS_DOMAIN}`);
  console.log("GITHUB_APP_EVENTS=check_run,issues,pull_request,pull_request_review,pull_request_review_thread,push,workflow_run");
  console.log("PRODUCTION_RECONCILIATION=COMPLETED");
}

async function assertPublicState(webhookSecret, accessToken, apiToken, audience, expectedDeliveryCount) {
  await assertSignedPing(webhookSecret, "PUBLIC");
  await assertProtectedHealth(accessToken, "FINAL");
  const finalAudience = accessAudience(accessToken, "FINAL");
  if (finalAudience !== audience) stop("FINAL_ACCESS_AUDIENCE_CHANGED", "parent Access application audience changed during reconciliation");
  const finalObservability = await assertObservabilityReady(accessToken, "FINAL");
  const finalDeliveryCount = await readDeliveryBaseline(apiToken);
  if (finalDeliveryCount !== Number(expectedDeliveryCount) || finalObservability.totalDeliveries !== finalDeliveryCount) {
    stop("FINAL_DELIVERY_COUNT", "side-effect-free reconciliation ping unexpectedly changed delivery durability state");
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") await plan(args);
  else await apply(args);
} catch {
  if (writeStarted) console.error("POST_WRITE_STATE=RECONCILE_REQUIRED");
  process.exitCode = 1;
}