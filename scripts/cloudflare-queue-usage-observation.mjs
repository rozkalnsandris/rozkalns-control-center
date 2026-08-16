import { pathToFileURL } from "node:url";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const API_BASE = "https://api.cloudflare.com/client/v4";
const EXPECTED_ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
const EXPECTED_QUEUE_ID = "31cf71912525401fa2a322b18fca26b2";
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_WINDOW_MS = 60 * 1000;
const ACTION_TYPES = ["WriteMessage", "ReadMessage", "DeleteMessage"];
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

export class QueueUsageObservationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QueueUsageObservationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new QueueUsageObservationError(code, message);
}

function requireUtcTimestamp(value, label) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fail("WINDOW_INVALID", `${label} must be a valid UTC timestamp ending in Z`);
  }
  return new Date(value).toISOString();
}

export function parseObservationArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail("ARGUMENT_INVALID", "Only named arguments are supported");
    if (arg === "--help") return { help: true };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail("ARGUMENT_INVALID", `${arg} requires a value`);
    if (values.has(arg)) fail("ARGUMENT_INVALID", `${arg} may only be supplied once`);
    values.set(arg, value);
    index += 1;
  }

  const allowed = new Set(["--queue-id", "--from", "--to"]);
  for (const key of values.keys()) if (!allowed.has(key)) fail("ARGUMENT_INVALID", `Unsupported argument ${key}`);

  const queueId = values.get("--queue-id");
  if (queueId !== EXPECTED_QUEUE_ID) {
    fail("QUEUE_ID_MISMATCH", "Queue id must match the reviewed production reconciliation Queue");
  }

  const from = requireUtcTimestamp(values.get("--from"), "--from");
  const to = requireUtcTimestamp(values.get("--to"), "--to");
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const windowMs = toMs - fromMs;
  if (windowMs < MIN_WINDOW_MS || windowMs > MAX_WINDOW_MS) {
    fail("WINDOW_INVALID", "Observation window must be between one minute and 24 hours");
  }

  return {
    help: false,
    queueId,
    from,
    to,
    windowMinutes: Math.ceil(windowMs / 60_000),
  };
}

export function buildMessageOperationsQuery({ accountId, queueId, from, to }) {
  if (accountId !== EXPECTED_ACCOUNT_ID) fail("ACCOUNT_ID_MISMATCH", "Unexpected Cloudflare account id");
  if (queueId !== EXPECTED_QUEUE_ID) fail("QUEUE_ID_MISMATCH", "Unexpected Queue id");
  const safeFrom = requireUtcTimestamp(from, "from");
  const safeTo = requireUtcTimestamp(to, "to");

  return `query QueueMessageOperationsObservation {
  viewer {
    accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
      queueMessageOperationsAdaptiveGroups(
        limit: 10000
        filter: {
          queueId: ${JSON.stringify(queueId)}
          datetime_geq: ${JSON.stringify(safeFrom)}
          datetime_leq: ${JSON.stringify(safeTo)}
        }
        orderBy: [datetimeMinute_DESC]
      ) {
        sum {
          billableOperations
        }
        dimensions {
          datetimeMinute
          actionType
        }
      }
    }
  }
}`;
}

function nonNegativeFiniteNumber(value, code, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(code, `${label} must be a non-negative finite number`);
  }
  return value;
}

export function parseMessageOperationsPayload(payload, windowMinutes) {
  if (!Number.isInteger(windowMinutes) || windowMinutes <= 0 || windowMinutes > 24 * 60) {
    fail("WINDOW_INVALID", "windowMinutes is outside the reviewed bound");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    fail("GRAPHQL_RESPONSE_INVALID", "GraphQL response must be an object");
  }
  const errors = payload.errors;
  if (errors !== undefined && (!Array.isArray(errors) || errors.length !== 0)) {
    fail("GRAPHQL_RESPONSE_ERROR", "GraphQL returned errors");
  }
  const accounts = payload?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    fail("GRAPHQL_ACCOUNT_INVALID", "GraphQL must resolve exactly one account");
  }
  const rows = accounts[0]?.queueMessageOperationsAdaptiveGroups;
  if (!Array.isArray(rows) || rows.length > 10_000) {
    fail("GRAPHQL_ROWS_INVALID", "Message-operation rows are missing or exceed the reviewed limit");
  }

  const byAction = Object.fromEntries(ACTION_TYPES.map((action) => [action, 0]));
  const byMinute = new Map();
  let total = 0;

  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      fail("GRAPHQL_ROW_INVALID", "Message-operation row must be an object");
    }
    const action = row?.dimensions?.actionType;
    const minute = row?.dimensions?.datetimeMinute;
    if (!ACTION_TYPES.includes(action)) fail("GRAPHQL_ACTION_INVALID", "Unexpected Queue action type");
    if (typeof minute !== "string" || Number.isNaN(Date.parse(minute))) {
      fail("GRAPHQL_MINUTE_INVALID", "Queue operation minute is invalid");
    }
    const billable = nonNegativeFiniteNumber(
      row?.sum?.billableOperations,
      "GRAPHQL_BILLABLE_INVALID",
      "billableOperations",
    );
    byAction[action] += billable;
    byMinute.set(minute, (byMinute.get(minute) ?? 0) + billable);
    total += billable;
  }

  let peakPerMinute = 0;
  for (const value of byMinute.values()) peakPerMinute = Math.max(peakPerMinute, value);

  return {
    rows: rows.length,
    total,
    write: byAction.WriteMessage,
    read: byAction.ReadMessage,
    delete: byAction.DeleteMessage,
    observedMinutesWithOperations: byMinute.size,
    peakPerMinute,
    operationsPerWindowMinute: total / windowMinutes,
  };
}

export function parseQueueMetricsPayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload) || payload.success !== true) {
    fail("REST_METRICS_INVALID", "Queue metrics response is not a successful object");
  }
  const result = payload.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    fail("REST_METRICS_INVALID", "Queue metrics result is missing");
  }
  return {
    backlogCount: nonNegativeFiniteNumber(result.backlog_count, "REST_METRICS_INVALID", "backlog_count"),
    backlogBytes: nonNegativeFiniteNumber(result.backlog_bytes, "REST_METRICS_INVALID", "backlog_bytes"),
    oldestMessageTimestampMs: nonNegativeFiniteNumber(
      result.oldest_message_timestamp_ms,
      "REST_METRICS_INVALID",
      "oldest_message_timestamp_ms",
    ),
  };
}

async function readJson(response, code) {
  if (!response.ok) fail(code, `Cloudflare read returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    fail(code, "Cloudflare read did not return JSON");
  }
}

async function observe({ apiToken, queueId, from, to, windowMinutes }) {
  const query = buildMessageOperationsQuery({
    accountId: EXPECTED_ACCOUNT_ID,
    queueId,
    from,
    to,
  });
  const graphqlResponse = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const operations = parseMessageOperationsPayload(
    await readJson(graphqlResponse, "GRAPHQL_READ_FAILED"),
    windowMinutes,
  );

  const metricsUrl = `${API_BASE}/accounts/${encodeURIComponent(EXPECTED_ACCOUNT_ID)}/queues/${encodeURIComponent(queueId)}/metrics`;
  const metricsResponse = await fetch(metricsUrl, {
    method: "GET",
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const backlog = parseQueueMetricsPayload(await readJson(metricsResponse, "REST_METRICS_READ_FAILED"));
  return { operations, backlog };
}

function help() {
  console.log("QUEUE_USAGE_OBSERVATION=READ_ONLY");
  console.log("USAGE=node scripts/cloudflare-queue-usage-observation.mjs --queue-id <exact-id> --from <UTC-Z> --to <UTC-Z>");
  console.log("GRAPHQL_QUERY=QUEUE_MESSAGE_OPERATIONS_ONLY");
  console.log("REST_METHOD=GET_ONLY");
  console.log("CLOUDFLARE_MUTATION=NO");
}

async function main() {
  const args = parseObservationArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (accountId !== EXPECTED_ACCOUNT_ID) fail("ACCOUNT_ID_MISMATCH", "CLOUDFLARE_ACCOUNT_ID does not match reviewed account");
  if (typeof apiToken !== "string" || apiToken.length < 1) fail("API_TOKEN_MISSING", "CLOUDFLARE_API_TOKEN is required locally");

  const evidence = await observe({ apiToken, ...args });
  console.log("QUEUE_USAGE_OBSERVATION=PASS");
  console.log("CLOUDFLARE_MUTATION=NO");
  console.log("GRAPHQL_QUERY=QUEUE_MESSAGE_OPERATIONS_ONLY");
  console.log("REST_METHOD=GET_ONLY");
  console.log(`QUEUE_ID=${args.queueId}`);
  console.log(`WINDOW_START=${args.from}`);
  console.log(`WINDOW_END=${args.to}`);
  console.log(`WINDOW_MINUTES=${args.windowMinutes}`);
  console.log(`GRAPHQL_ROWS=${evidence.operations.rows}`);
  console.log(`BILLABLE_OPERATIONS_TOTAL=${evidence.operations.total}`);
  console.log(`WRITE_BILLABLE_OPERATIONS=${evidence.operations.write}`);
  console.log(`READ_BILLABLE_OPERATIONS=${evidence.operations.read}`);
  console.log(`DELETE_BILLABLE_OPERATIONS=${evidence.operations.delete}`);
  console.log(`OBSERVED_MINUTES_WITH_OPERATIONS=${evidence.operations.observedMinutesWithOperations}`);
  console.log(`PEAK_BILLABLE_OPERATIONS_PER_MINUTE=${evidence.operations.peakPerMinute}`);
  console.log(`BILLABLE_OPERATIONS_PER_WINDOW_MINUTE=${evidence.operations.operationsPerWindowMinute.toFixed(6)}`);
  console.log(`BACKLOG_COUNT=${evidence.backlog.backlogCount}`);
  console.log(`BACKLOG_BYTES=${evidence.backlog.backlogBytes}`);
  console.log(`OLDEST_MESSAGE_TIMESTAMP_MS=${evidence.backlog.oldestMessageTimestampMs}`);
  console.log("BACKLOG_METRICS=BEST_EFFORT_POINT_IN_TIME");
  console.log("STABILITY_DECISION=NOT_AUTOMATIC");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof QueueUsageObservationError ? error.code : "UNEXPECTED_ERROR";
    console.error(`STOP=${code}`);
    process.exitCode = 1;
  });
}
