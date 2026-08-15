#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const AUTH_PREFIX = `authorize Phase 2 webhook Queue activation ${HOSTNAME} `;
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
let temporarySecretsDirectory = "";

function parseArgs(argv) {
  const out = {
    mode: "plan",
    sha: "",
    ci: "",
    currentVersion: "",
    currentDeployment: "",
    domainId: "",
    accessAppId: "",
    deliveryCount: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode") out.mode = argv[++index] ?? "";
    else if (argv[index] === "--expected-sha") out.sha = argv[++index] ?? "";
    else if (argv[index] === "--expected-ci-run-id") out.ci = argv[++index] ?? "";
    else if (argv[index] === "--expected-current-version-id") out.currentVersion = argv[++index] ?? "";
    else if (argv[index] === "--expected-current-deployment-id") out.currentDeployment = argv[++index] ?? "";
    else if (argv[index] === "--expected-domain-id") out.domainId = argv[++index] ?? "";
    else if (argv[index] === "--expected-access-app-id") out.accessAppId = argv[++index] ?? "";
    else if (argv[index] === "--expected-delivery-count") out.deliveryCount = argv[++index] ?? "";
    else stop("ARGUMENT_INVALID", `unsupported argument ${argv[index]}`);
  }

  if (out.mode !== "plan" && out.mode !== "apply") stop("MODE_INVALID", "mode must be plan or apply");
  return out;
}

function assertVersionId(value, code, label) {
  if (!UUID_PATTERN.test(value)) stop(code, `${label} must be a lowercase UUID`);
}

function assertOpaqueId(value, code, label) {
  if (!OPAQUE_ID_PATTERN.test(value)) stop(code, `${label} must be a bounded opaque identifier`);
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
  if (!apiToken) stop("API_TOKEN_REQUIRED", "temporary Cloudflare setup token is required");
  return apiToken;
}

function sanitizedChildEnvironment(apiToken = "") {
  const env = apiToken ? childEnvironment(apiToken) : cleanEnv();
  delete env.CONTROL_GITHUB_WEBHOOK_SECRET;
  delete env.GITHUB_WEBHOOK_SECRET;
  delete env.CONTROL_ACCESS_TOKEN;
  delete env.CONTROL_OWNER_AUTHORIZATION;
  return env;
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
    (binding) =>
      binding?.name === name &&
      (binding?.type === "secret_text" || binding?.type === "secret_key"),
  );
  if (matches.length !== 1) stop(`${codePrefix}_${name}_SECRET`, `${name} secret binding was not uniquely present`);
}

function assertBindingAbsent(detail, name, codePrefix) {
  const bindings = detail?.resources?.bindings;
  if (!Array.isArray(bindings)) stop(`${codePrefix}_BINDINGS_INVALID`, "version bindings were not available");
  if (bindings.some((binding) => binding?.name === name)) {
    stop(`${codePrefix}_${name}_UNEXPECTED`, `${name} must be absent before first webhook Queue activation`);
  }
}

function assertCurrentDormantVersion(detail, codePrefix) {
  assertRequiredBindings(detail, codePrefix);
  assertPlainTextBinding(detail, "GITHUB_APP_CLIENT_ID", APP_CLIENT_ID, codePrefix);
  assertPlainTextBinding(detail, "GITHUB_APP_INSTALLATION_ID", INSTALLATION_ID, codePrefix);
  assertPlainTextBinding(detail, "CONTROL_LIVE_READ_ENABLED", "true", codePrefix);
  assertBindingAbsent(detail, "CONTROL_WEBHOOK_RUNTIME_ENABLED", codePrefix);
  assertBindingAbsent(detail, WEBHOOK_SECRET_NAME, codePrefix);
  assertBindingAbsent(detail, "RECONCILIATION_QUEUE", codePrefix);
}

function assertActivatedVersion(detail, codePrefix) {
  assertRequiredBindings(detail, codePrefix);
  assertPlainTextBinding(detail, "GITHUB_APP_CLIENT_ID", APP_CLIENT_ID, codePrefix);
  assertPlainTextBinding(detail, "GITHUB_APP_INSTALLATION_ID", INSTALLATION_ID, codePrefix);
  assertPlainTextBinding(detail, "CONTROL_LIVE_READ_ENABLED", "true", codePrefix);
  assertPlainTextBinding(detail, "CONTROL_WEBHOOK_RUNTIME_ENABLED", "true", codePrefix);
  assertSecretBinding(detail, WEBHOOK_SECRET_NAME, codePrefix);
}

async function assertActivationSourceConfig() {
  const pkg = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile("package.json", "utf8")));
  if (pkg?.devDependencies?.wrangler !== WRANGLER_VERSION) stop("WRANGLER_PIN_INVALID", "repository Wrangler pin changed");

  const config = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile("wrangler.jsonc", "utf8")));
  if (config?.name !== WORKER_NAME) stop("WORKER_NAME_INVALID", "Worker target changed");
  if (config?.workers_dev !== false) stop("WORKERS_DEV_NOT_DISABLED", "workers.dev must remain disabled");
  if (config?.preview_urls !== false) stop("PREVIEW_URLS_NOT_DISABLED", "Preview URLs must remain disabled");
  if (config?.vars?.GITHUB_APP_CLIENT_ID !== APP_CLIENT_ID) stop("APP_CLIENT_ID_INVALID", "GitHub App client id changed");
  if (config?.vars?.GITHUB_APP_INSTALLATION_ID !== INSTALLATION_ID) stop("INSTALLATION_ID_INVALID", "GitHub App installation id changed");
  if (config?.vars?.CONTROL_LIVE_READ_ENABLED !== "true") stop("LIVE_READ_NOT_ENABLED", "live read must remain enabled");
  if (config?.vars?.CONTROL_WEBHOOK_RUNTIME_ENABLED !== "true") stop("WEBHOOK_RUNTIME_NOT_ENABLED", "reviewed activation source must enable the runtime gate");

  const requiredSecrets = config?.secrets?.required;
  if (
    !Array.isArray(requiredSecrets) ||
    JSON.stringify(requiredSecrets) !== JSON.stringify(["GITHUB_APP_PRIVATE_KEY_PEM", WEBHOOK_SECRET_NAME])
  ) {
    stop("SECRET_CONTRACT_INVALID", "required secret names changed");
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

  const consumers = config?.queues?.consumers;
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
  if (JSON.stringify(consumers) !== JSON.stringify(expectedConsumers)) {
    stop("QUEUE_CONSUMER_CONFIG_INVALID", "reviewed Queue consumer policy changed");
  }

  if (
    config?.assets?.directory !== "./dist/client" ||
    config?.assets?.not_found_handling !== "single-page-application" ||
    JSON.stringify(config?.assets?.run_worker_first) !== JSON.stringify(["/api/*"])
  ) {
    stop("ASSETS_CONFIG_INVALID", "reviewed SPA/API routing changed");
  }
  for (const forbidden of ["route", "routes", "triggers", "custom_domain", "custom_domains"]) {
    if (Object.hasOwn(config, forbidden)) stop("SOURCE_ROUTING_PRESENT", `${forbidden} is forbidden in activation source`);
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

function targetQueueMatches(queues, name) {
  return queues.filter((queue) => queue?.queue_name === name);
}

function assertTargetQueuesAbsent(queues, codePrefix) {
  for (const name of [MAIN_QUEUE_NAME, DLQ_NAME]) {
    if (targetQueueMatches(queues, name).length !== 0) {
      stop(`${codePrefix}_QUEUE_PRESENT`, `${name} already exists; first activation requires a clean target Queue baseline`);
    }
  }
}

function exactQueue(queues, name, codePrefix) {
  const matches = targetQueueMatches(queues, name);
  if (matches.length !== 1) stop(`${codePrefix}_QUEUE_STATE`, `${name} was not uniquely present`);
  const queue = matches[0];
  if (typeof queue?.queue_id !== "string" || !OPAQUE_ID_PATTERN.test(queue.queue_id)) {
    stop(`${codePrefix}_QUEUE_ID`, `${name} queue id was invalid`);
  }
  return queue;
}

async function listQueueConsumers(apiToken, queueId) {
  const consumers = await cfGet(apiToken, `/queues/${encodeURIComponent(queueId)}/consumers`);
  if (!Array.isArray(consumers)) stop("QUEUE_CONSUMERS_INVALID", "Queue consumer inventory was not an array");
  return consumers;
}

function assertConsumer(consumer, expected, codePrefix) {
  if (consumer?.type !== "worker" || consumer?.script_name !== WORKER_NAME) {
    stop(`${codePrefix}_SCRIPT`, "Queue consumer is not bound to the reviewed Worker");
  }
  const settings = consumer?.settings ?? {};
  if (
    settings.batch_size !== expected.batchSize ||
    settings.max_wait_time_ms !== expected.maxWaitTimeMs ||
    settings.max_retries !== expected.maxRetries ||
    settings.max_concurrency !== expected.maxConcurrency ||
    (expected.retryDelay !== undefined && settings.retry_delay !== expected.retryDelay)
  ) {
    stop(`${codePrefix}_SETTINGS`, "Queue consumer settings do not match reviewed bounded policy");
  }
  if (expected.deadLetterQueue) {
    if (consumer?.dead_letter_queue !== expected.deadLetterQueue) {
      stop(`${codePrefix}_DLQ`, "main Queue consumer dead-letter target changed");
    }
  } else if (consumer?.dead_letter_queue) {
    stop(`${codePrefix}_UNEXPECTED_DLQ`, "DLQ consumer must not have another dead-letter target");
  }
}

async function assertActivatedQueues(apiToken, codePrefix) {
  const queues = await listQueues(apiToken);
  const main = exactQueue(queues, MAIN_QUEUE_NAME, `${codePrefix}_MAIN`);
  const dlq = exactQueue(queues, DLQ_NAME, `${codePrefix}_DLQ`);

  const mainConsumers = await listQueueConsumers(apiToken, main.queue_id);
  const dlqConsumers = await listQueueConsumers(apiToken, dlq.queue_id);
  if (mainConsumers.length !== 1 || dlqConsumers.length !== 1) {
    stop(`${codePrefix}_CONSUMER_COUNT`, "each reviewed Queue must have exactly one consumer");
  }
  assertConsumer(
    mainConsumers[0],
    {
      batchSize: 10,
      maxWaitTimeMs: 5000,
      maxRetries: 3,
      retryDelay: 30,
      maxConcurrency: 1,
      deadLetterQueue: DLQ_NAME,
    },
    `${codePrefix}_MAIN_CONSUMER`,
  );
  assertConsumer(
    dlqConsumers[0],
    { batchSize: 10, maxWaitTimeMs: 5000, maxRetries: 3, maxConcurrency: 1 },
    `${codePrefix}_DLQ_CONSUMER`,
  );

  const producers = Array.isArray(main?.producers) ? main.producers : [];
  const workerProducers = producers.filter(
    (producer) => producer?.type === "worker" && producer?.script === WORKER_NAME,
  );
  if (workerProducers.length !== 1) {
    stop(`${codePrefix}_PRODUCER`, "main Queue does not show the reviewed Worker as its producer");
  }

  return { main, dlq, mainConsumer: mainConsumers[0], dlqConsumer: dlqConsumers[0] };
}

async function listAccessApps(apiToken) {
  const apps = await cfGet(apiToken, "/access/apps");
  if (!Array.isArray(apps)) stop("ACCESS_APP_INVENTORY_INVALID", "Access application inventory was not an array");
  return apps;
}

function parentAccessApps(apps) {
  return apps.filter((app) => app?.type === "self_hosted" && app?.domain === HOSTNAME);
}

function webhookAccessApps(apps) {
  return apps.filter((app) => app?.type === "self_hosted" && app?.domain === WEBHOOK_ACCESS_DOMAIN);
}

function exactParentAccessApp(apps, expectedId = "", codePrefix = "ACCESS") {
  const matches = parentAccessApps(apps).filter((app) => expectedId === "" || app?.id === expectedId);
  if (matches.length !== 1) stop(`${codePrefix}_PARENT_APP`, "parent Control Access application was not uniquely proven");
  const app = matches[0];
  if (typeof app?.id !== "string" || !UUID_PATTERN.test(app.id)) stop(`${codePrefix}_PARENT_APP_ID`, "parent Access app id is invalid");
  return app;
}

function assertWebhookAccessAbsent(apps, codePrefix) {
  if (webhookAccessApps(apps).length !== 0) {
    stop(`${codePrefix}_WEBHOOK_APP_PRESENT`, "exact webhook Access application already exists; reconcile instead of rerunning activation");
  }
}

async function assertActivatedAccess(apiToken, expectedParentId, expectedWebhookAppId, expectedPolicyId, codePrefix) {
  const apps = await listAccessApps(apiToken);
  const parent = exactParentAccessApp(apps, expectedParentId, `${codePrefix}_PARENT`);
  const webhookMatches = webhookAccessApps(apps).filter((app) => app?.id === expectedWebhookAppId);
  if (webhookMatches.length !== 1) stop(`${codePrefix}_WEBHOOK_APP`, "exact webhook Access application was not uniquely proven");
  const webhook = webhookMatches[0];
  if (webhook?.name !== WEBHOOK_ACCESS_APP_NAME || webhook?.app_launcher_visible !== false) {
    stop(`${codePrefix}_WEBHOOK_APP_SHAPE`, "webhook Access application shape changed");
  }

  const policies = await cfGet(apiToken, `/access/apps/${encodeURIComponent(webhook.id)}/policies`);
  if (!Array.isArray(policies)) stop(`${codePrefix}_POLICY_INVENTORY`, "webhook Access policy inventory was not an array");
  const matches = policies.filter((policy) => policy?.id === expectedPolicyId);
  if (matches.length !== 1) stop(`${codePrefix}_POLICY`, "exact webhook bypass policy was not uniquely proven");
  const policy = matches[0];
  const everyone = Array.isArray(policy?.include) && policy.include.length === 1 && policy.include[0]?.everyone;
  if (
    policy?.name !== WEBHOOK_ACCESS_POLICY_NAME ||
    policy?.decision !== "bypass" ||
    policy?.precedence !== 1 ||
    !everyone
  ) {
    stop(`${codePrefix}_POLICY_SHAPE`, "webhook Access bypass policy does not match reviewed exact-path policy");
  }
  return { parent, webhook, policy };
}

async function d1ReadOnlyQuery(apiToken, sql) {
  let response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    stop("D1_READ_FAILED", "D1 read-only query request failed");
  }
  if (!response.ok) stop("D1_READ_FAILED", `D1 read-only query returned HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    stop("D1_READ_INVALID", "D1 read-only query did not return JSON");
  }
  if (payload?.success !== true || !Array.isArray(payload?.result) || payload.result.length !== 1) {
    stop("D1_READ_INVALID", "D1 read-only query response was unsuccessful or ambiguous");
  }
  const result = payload.result[0];
  if (result?.success !== true || !Array.isArray(result?.results)) {
    stop("D1_READ_INVALID", "D1 read-only query result was unsuccessful");
  }
  if (result?.meta?.changed_db === true || Number(result?.meta?.changes ?? 0) !== 0) {
    stop("D1_READ_MUTATED", "read-only D1 preflight unexpectedly reported a mutation");
  }
  return result.results;
}

async function readDeliveryBaseline(apiToken) {
  const columns = await d1ReadOnlyQuery(apiToken, "PRAGMA table_info(webhook_deliveries)");
  const names = columns.map((row) => row?.name);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_DELIVERY_COLUMNS)) {
    stop("D1_SCHEMA_MISMATCH", "webhook_deliveries schema does not match reviewed migration");
  }
  const rows = await d1ReadOnlyQuery(apiToken, "SELECT COUNT(*) AS count FROM webhook_deliveries");
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.count) || rows[0].count < 0) {
    stop("D1_DELIVERY_COUNT_INVALID", "webhook delivery baseline count was invalid");
  }
  return rows[0].count;
}

async function readAccessJson(path, accessToken, codePrefix) {
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
    stop(`${codePrefix}_READ`, "Access-authenticated request failed");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    stop(`${codePrefix}_MEDIA_TYPE`, "Access-authenticated response must be JSON");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    stop(`${codePrefix}_JSON`, "Access-authenticated response JSON could not be parsed");
  }
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
  ) {
    stop(`${codePrefix}_OBSERVABILITY_SHAPE`, "webhook delivery observability shape was invalid");
  }
  return body;
}

async function assertPublicSignedPing(secret, codePrefix) {
  const payload = JSON.stringify({ zen: "Rozkalns Control activation canary", hook_id: 155 });
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  let response;
  try {
    response = await fetch(`https://${WEBHOOK_ACCESS_DOMAIN}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-GitHub-Delivery": "rozkalns-control-activation-ping",
        "X-GitHub-Event": "ping",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    stop(`${codePrefix}_PING_READ`, "public signed webhook ping request failed");
  }
  if (!response.headers.get("cache-control")?.includes("no-store")) {
    stop(`${codePrefix}_PING_CACHE`, "signed webhook ping response must be no-store");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    stop(`${codePrefix}_PING_JSON`, "signed webhook ping did not return JSON");
  }
  if (response.status !== 200 || body?.status !== "PING") {
    stop(`${codePrefix}_PING_RESULT`, "signed webhook ping did not prove the public HMAC endpoint");
  }
}

function versionIdSet(versions, codePrefix) {
  const ids = versions.map((version) => version?.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    stop(`${codePrefix}_VERSION_SET_INVALID`, "Worker version inventory contained invalid or duplicate ids");
  }
  return new Set(ids);
}

async function readFreshPrewrite(apiToken, args, requireExpected) {
  const active = singleDeploymentVersion(await listDeployments(apiToken), "PREWRITE");
  if (requireExpected) {
    if (active.versionId !== args.currentVersion || active.deploymentId !== args.currentDeployment) {
      stop("PREWRITE_ACTIVE_STATE", "active Worker version/deployment moved from authorized baseline");
    }
  }
  assertCurrentDormantVersion(await versionDetail(apiToken, active.versionId), "PREWRITE");
  await assertSubdomainDisabled(apiToken, "PREWRITE");

  const domain = await readExactDomain(apiToken, requireExpected ? args.domainId : "", "PREWRITE");
  const apps = await listAccessApps(apiToken);
  const parent = exactParentAccessApp(apps, requireExpected ? args.accessAppId : "", "PREWRITE");
  assertWebhookAccessAbsent(apps, "PREWRITE");
  assertTargetQueuesAbsent(await listQueues(apiToken), "PREWRITE");
  const deliveryCount = await readDeliveryBaseline(apiToken);
  if (requireExpected && deliveryCount !== Number(args.deliveryCount)) {
    stop("PREWRITE_DELIVERY_COUNT", "D1 delivery baseline moved from authorized value");
  }
  return { active, domain, parent, deliveryCount };
}

async function prepareSecretFile(secret) {
  temporarySecretsDirectory = await mkdtemp(join(tmpdir(), "rozkalns-control-webhook-"));
  const path = join(temporarySecretsDirectory, "secrets.json");
  await writeFile(path, `${JSON.stringify({ [WEBHOOK_SECRET_NAME]: secret })}\n`, { mode: 0o600 });
  return path;
}

async function cleanupSecretFile() {
  if (!temporarySecretsDirectory) return;
  try {
    await rm(temporarySecretsDirectory, { recursive: true, force: true });
  } finally {
    temporarySecretsDirectory = "";
  }
}

function planOutput(args, prewrite) {
  console.log("WEBHOOK_QUEUE_ACTIVATION_GATE=PLAN_PASS");
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("D1_QUERY_MODE=READ_ONLY_SQL");
  console.log(`SOURCE_SHA=${args.sha}`);
  console.log(`CI_RUN_ID=${args.ci}`);
  console.log(`CURRENT_VERSION_ID=${prewrite.active.versionId}`);
  console.log(`CURRENT_DEPLOYMENT_ID=${prewrite.active.deploymentId}`);
  console.log(`DOMAIN_ID=${prewrite.domain.id}`);
  console.log(`PARENT_ACCESS_APP_ID=${prewrite.parent.id}`);
  console.log(`WEBHOOK_DELIVERY_BASELINE=${prewrite.deliveryCount}`);
  console.log("TARGET_QUEUES=ABSENT");
  console.log("TARGET_WEBHOOK_ACCESS_APP=ABSENT");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("GITHUB_PERMISSION_GROWTH=NO");
  console.log("GITHUB_APP_SETTINGS_MUTATION=NOT_INCLUDED_IN_CLOUDFLARE_APPLY");
  console.log(
    `OWNER_AUTHORIZATION=${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${prewrite.active.versionId} ` +
      `deployment ${prewrite.active.deploymentId} domain ${prewrite.domain.id} access ${prewrite.parent.id} ` +
      `deliveries ${prewrite.deliveryCount} queues absent`,
  );
  console.log("NO_BLIND_RETRY_AFTER_WRITE_STARTED=YES");
}

async function plan(args) {
  assertBaseInputs(args.sha, args.ci);
  const apiToken = requiredAccountAndToken();
  const accessToken = process.env.CONTROL_ACCESS_TOKEN ?? "";
  if (!accessToken) stop("ACCESS_TOKEN_REQUIRED", "short-lived Cloudflare Access user token is required");

  assertRepo(args.sha);
  await assertActivationSourceConfig();
  await assertCi(args.sha, args.ci);
  run("npm", ["run", "check"], { inherit: true, env: sanitizedChildEnvironment() });
  await assertProtectedHealth(accessToken, "PLAN");
  const prewrite = await readFreshPrewrite(apiToken, args, false);
  planOutput(args, prewrite);
}

async function apply(args) {
  assertBaseInputs(args.sha, args.ci);
  assertVersionId(args.currentVersion, "CURRENT_VERSION_ID_INVALID", "current Worker version id");
  assertVersionId(args.currentDeployment, "CURRENT_DEPLOYMENT_ID_INVALID", "current Worker deployment id");
  assertOpaqueId(args.domainId, "DOMAIN_ID_INVALID", "custom domain id");
  assertVersionId(args.accessAppId, "ACCESS_APP_ID_INVALID", "parent Access app id");
  assertDeliveryCount(args.deliveryCount);

  const apiToken = requiredAccountAndToken();
  const accessToken = process.env.CONTROL_ACCESS_TOKEN ?? "";
  const authorization = process.env.CONTROL_OWNER_AUTHORIZATION ?? "";
  const webhookSecret = process.env.CONTROL_GITHUB_WEBHOOK_SECRET ?? "";
  if (!accessToken) stop("ACCESS_TOKEN_REQUIRED", "short-lived Cloudflare Access user token is required");
  if (webhookSecret.length < 32 || webhookSecret.length > 512) {
    stop("WEBHOOK_SECRET_INVALID", "webhook secret must be high-entropy and 32..512 characters");
  }

  const expectedAuthorization =
    `${AUTH_PREFIX}${args.sha} ci ${args.ci} version ${args.currentVersion} deployment ${args.currentDeployment} ` +
    `domain ${args.domainId} access ${args.accessAppId} deliveries ${args.deliveryCount} queues absent`;
  if (authorization !== expectedAuthorization) {
    stop("OWNER_AUTHORIZATION_INVALID", "owner authorization does not match exact fresh activation baseline");
  }

  assertRepo(args.sha);
  await assertActivationSourceConfig();
  await assertCi(args.sha, args.ci);
  run("npm", ["run", "check"], { inherit: true, env: sanitizedChildEnvironment() });
  await assertProtectedHealth(accessToken, "PREWRITE");
  const beforeIds = versionIdSet(await listVersions(apiToken), "PREWRITE");
  await readFreshPrewrite(apiToken, args, true);

  // Repeat every trust-boundary input immediately before the first write.
  assertRepo(args.sha);
  await assertActivationSourceConfig();
  await assertCi(args.sha, args.ci);
  await assertProtectedHealth(accessToken, "FINAL_PREWRITE");
  await readFreshPrewrite(apiToken, args, true);
  const finalBeforeIds = versionIdSet(await listVersions(apiToken), "FINAL_PREWRITE");
  if (beforeIds.size !== finalBeforeIds.size || [...beforeIds].some((id) => !finalBeforeIds.has(id))) {
    stop("FINAL_PREWRITE_VERSION_SET_CHANGED", "Worker version inventory changed during activation preflight");
  }

  console.log("WRITE_STARTED=YES");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log("NO_BLIND_RETRY_IF_STOP_AFTER_WRITE_STARTED=YES");
  writeStarted = true;

  const mainQueue = await cfWrite(apiToken, "/queues", "POST", { queue_name: MAIN_QUEUE_NAME });
  const dlq = await cfWrite(apiToken, "/queues", "POST", { queue_name: DLQ_NAME });
  if (!OPAQUE_ID_PATTERN.test(mainQueue?.queue_id ?? "") || !OPAQUE_ID_PATTERN.test(dlq?.queue_id ?? "")) {
    stop("QUEUE_CREATE_INVALID", "created Queue identities were invalid");
  }

  const secretsFile = await prepareSecretFile(webhookSecret);
  try {
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
        "--secrets-file",
        secretsFile,
      ],
      { inherit: true, env: sanitizedChildEnvironment(apiToken) },
    );
  } finally {
    await cleanupSecretFile();
  }

  const afterVersions = await listVersions(apiToken);
  const newVersions = afterVersions.filter(
    (version) => typeof version?.id === "string" && !beforeIds.has(version.id),
  );
  if (newVersions.length !== 1) stop("POST_VERIFY_NEW_VERSION", "expected exactly one new Worker version after activation deploy");
  const newVersionId = newVersions[0].id;
  const active = singleDeploymentVersion(await listDeployments(apiToken), "POST_VERIFY");
  if (active.versionId !== newVersionId || active.deploymentId === args.currentDeployment) {
    stop("POST_VERIFY_ACTIVE_DEPLOYMENT", "activation deploy did not become the unique 100% active Worker version");
  }
  assertActivatedVersion(await versionDetail(apiToken, newVersionId), "POST_VERIFY");
  await assertSubdomainDisabled(apiToken, "POST_VERIFY");
  const domain = await readExactDomain(apiToken, args.domainId, "POST_VERIFY");
  const activatedQueues = await assertActivatedQueues(apiToken, "POST_VERIFY");
  await assertProtectedHealth(accessToken, "POST_VERIFY");
  const observability = await assertObservabilityReady(accessToken, "POST_VERIFY");

  const accessApp = await cfWrite(apiToken, "/access/apps", "POST", {
    name: WEBHOOK_ACCESS_APP_NAME,
    type: "self_hosted",
    domain: WEBHOOK_ACCESS_DOMAIN,
    app_launcher_visible: false,
  });
  if (!UUID_PATTERN.test(accessApp?.id ?? "")) stop("ACCESS_WEBHOOK_APP_CREATE", "created webhook Access app id was invalid");

  const bypassPolicy = await cfWrite(
    apiToken,
    `/access/apps/${encodeURIComponent(accessApp.id)}/policies`,
    "POST",
    {
      name: WEBHOOK_ACCESS_POLICY_NAME,
      decision: "bypass",
      precedence: 1,
      include: [{ everyone: {} }],
      exclude: [],
      require: [],
    },
  );
  if (!UUID_PATTERN.test(bypassPolicy?.id ?? "")) stop("ACCESS_WEBHOOK_POLICY_CREATE", "created bypass policy id was invalid");

  await assertActivatedAccess(apiToken, args.accessAppId, accessApp.id, bypassPolicy.id, "POST_VERIFY");
  await assertPublicSignedPing(webhookSecret, "POST_VERIFY");
  await assertProtectedHealth(accessToken, "FINAL");
  const finalObservability = await assertObservabilityReady(accessToken, "FINAL");

  console.log("WEBHOOK_QUEUE_ACTIVATION_GATE=PASS");
  console.log("AUTHORIZATION_CONSUMED=YES");
  console.log(`NEW_VERSION_ID=${newVersionId}`);
  console.log(`ACTIVE_DEPLOYMENT_ID=${active.deploymentId}`);
  console.log("ACTIVE_TRAFFIC_PERCENT=100");
  console.log(`CUSTOM_DOMAIN=${domain.hostname}`);
  console.log(`DOMAIN_ID=${domain.id}`);
  console.log(`MAIN_QUEUE_ID=${activatedQueues.main.queue_id}`);
  console.log(`DLQ_ID=${activatedQueues.dlq.queue_id}`);
  console.log(`MAIN_QUEUE_CONSUMER_ID=${activatedQueues.mainConsumer.consumer_id}`);
  console.log(`DLQ_CONSUMER_ID=${activatedQueues.dlqConsumer.consumer_id}`);
  console.log(`WEBHOOK_ACCESS_APP_ID=${accessApp.id}`);
  console.log(`WEBHOOK_ACCESS_POLICY_ID=${bypassPolicy.id}`);
  console.log(`WEBHOOK_DELIVERY_TOTAL=${finalObservability.totalDeliveries}`);
  console.log(`WEBHOOK_DELIVERY_STATUS=${finalObservability.status}`);
  console.log(`PRE_DEPLOY_WEBHOOK_DELIVERY_TOTAL=${observability.totalDeliveries}`);
  console.log("CONTROL_WEBHOOK_RUNTIME_ENABLED=TRUE");
  console.log("GITHUB_WEBHOOK_SECRET_BINDING=PRESENT");
  console.log("PUBLIC_SIGNED_PING=PASS");
  console.log("ACCESS_PARENT_PROTECTION=PRESERVED");
  console.log("ACCESS_WEBHOOK_PATH_BYPASS=EXACT_PATH_ONLY");
  console.log("WORKERS_DEV=DISABLED");
  console.log("PREVIEW_URLS=DISABLED");
  console.log("GITHUB_PERMISSION_GROWTH=NO");
  console.log("GITHUB_APP_WEBHOOK_CONFIGURATION_REQUIRED=YES");
  console.log(`GITHUB_APP_WEBHOOK_URL=https://${WEBHOOK_ACCESS_DOMAIN}`);
  console.log("GITHUB_APP_EVENTS=check_run,issues,pull_request,pull_request_review,pull_request_review_thread,push,workflow_run");
  console.log("PRODUCTION_DEPLOY=COMPLETED");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "plan") await plan(args);
  else await apply(args);
} catch {
  await cleanupSecretFile();
  if (writeStarted) console.error("POST_WRITE_STATE=RECONCILE_REQUIRED");
  process.exitCode = 1;
}
