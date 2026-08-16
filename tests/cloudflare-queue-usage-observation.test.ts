import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const script = "scripts/cloudflare-queue-usage-observation.mjs";
const queueId = "31cf71912525401fa2a322b18fca26b2";

type ObservationModule = {
  parseObservationArgs(argv: string[]): {
    help: boolean;
    queueId?: string;
    from?: string;
    to?: string;
    windowMinutes?: number;
  };
  buildMessageOperationsQuery(input: {
    accountId: string;
    queueId: string;
    from: string;
    to: string;
  }): string;
  parseMessageOperationsPayload(payload: unknown, windowMinutes: number): {
    rows: number;
    total: number;
    write: number;
    read: number;
    delete: number;
    observedMinutesWithOperations: number;
    peakPerMinute: number;
    operationsPerWindowMinute: number;
  };
  parseQueueMetricsPayload(payload: unknown): {
    backlogCount: number;
    backlogBytes: number;
    oldestMessageTimestampMs: number;
  };
};

async function loadObservation(): Promise<ObservationModule> {
  return (await import(pathToFileURL(resolve(script)).href)) as ObservationModule;
}

test("Queue usage observation args bind exact production Queue and a bounded UTC window", async () => {
  const { parseObservationArgs } = await loadObservation();
  assert.deepEqual(
    parseObservationArgs([
      "--queue-id",
      queueId,
      "--from",
      "2026-08-16T00:00:00Z",
      "--to",
      "2026-08-16T06:00:00Z",
    ]),
    {
      help: false,
      queueId,
      from: "2026-08-16T00:00:00.000Z",
      to: "2026-08-16T06:00:00.000Z",
      windowMinutes: 360,
    },
  );

  assert.throws(() =>
    parseObservationArgs([
      "--queue-id",
      "00000000000000000000000000000000",
      "--from",
      "2026-08-16T00:00:00Z",
      "--to",
      "2026-08-16T01:00:00Z",
    ]),
  );
  assert.throws(() =>
    parseObservationArgs([
      "--queue-id",
      queueId,
      "--from",
      "2026-08-16T00:00:00+00:00",
      "--to",
      "2026-08-16T01:00:00Z",
    ]),
  );
  assert.throws(() =>
    parseObservationArgs([
      "--queue-id",
      queueId,
      "--from",
      "2026-08-15T00:00:00Z",
      "--to",
      "2026-08-16T00:01:00Z",
    ]),
  );
});

test("GraphQL query is bounded to exact account, Queue, window and message-operation analytics", async () => {
  const { buildMessageOperationsQuery } = await loadObservation();
  const query = buildMessageOperationsQuery({
    accountId: "70e29dbca0e8363358659102d2b74178",
    queueId,
    from: "2026-08-16T00:00:00Z",
    to: "2026-08-16T06:00:00Z",
  });
  assert.match(query, /^query QueueMessageOperationsObservation/);
  assert.match(query, /queueMessageOperationsAdaptiveGroups/);
  assert.match(query, /billableOperations/);
  assert.match(query, /datetimeMinute/);
  assert.match(query, /actionType/);
  assert.match(query, /limit: 10000/);
  assert.match(query, new RegExp(queueId));
  assert.doesNotMatch(query, /\bmutation\b/);
});

test("message-operation evidence is aggregated deterministically by action and minute", async () => {
  const { parseMessageOperationsPayload } = await loadObservation();
  const result = parseMessageOperationsPayload(
    {
      data: {
        viewer: {
          accounts: [
            {
              queueMessageOperationsAdaptiveGroups: [
                {
                  sum: { billableOperations: 2 },
                  dimensions: { datetimeMinute: "2026-08-16T00:01:00Z", actionType: "WriteMessage" },
                },
                {
                  sum: { billableOperations: 3 },
                  dimensions: { datetimeMinute: "2026-08-16T00:01:00Z", actionType: "ReadMessage" },
                },
                {
                  sum: { billableOperations: 1 },
                  dimensions: { datetimeMinute: "2026-08-16T00:02:00Z", actionType: "DeleteMessage" },
                },
              ],
            },
          ],
        },
      },
    },
    60,
  );
  assert.deepEqual(result, {
    rows: 3,
    total: 6,
    write: 2,
    read: 3,
    delete: 1,
    observedMinutesWithOperations: 2,
    peakPerMinute: 5,
    operationsPerWindowMinute: 0.1,
  });
});

test("message-operation evidence fails closed on errors, ambiguity and malformed values", async () => {
  const { parseMessageOperationsPayload } = await loadObservation();
  for (const payload of [
    { errors: [{ message: "denied" }], data: { viewer: { accounts: [] } } },
    { data: { viewer: { accounts: [] } } },
    { data: { viewer: { accounts: [{ queueMessageOperationsAdaptiveGroups: [] }, { queueMessageOperationsAdaptiveGroups: [] }] } } },
    {
      data: {
        viewer: {
          accounts: [{ queueMessageOperationsAdaptiveGroups: [{ sum: { billableOperations: -1 }, dimensions: { datetimeMinute: "2026-08-16T00:01:00Z", actionType: "WriteMessage" } }] }],
        },
      },
    },
    {
      data: {
        viewer: {
          accounts: [{ queueMessageOperationsAdaptiveGroups: [{ sum: { billableOperations: 1 }, dimensions: { datetimeMinute: "2026-08-16T00:01:00Z", actionType: "UnknownAction" } }] }],
        },
      },
    },
  ]) {
    assert.throws(() => parseMessageOperationsPayload(payload, 60));
  }
});

test("REST Queue metrics parser accepts only successful non-negative best-effort evidence", async () => {
  const { parseQueueMetricsPayload } = await loadObservation();
  assert.deepEqual(
    parseQueueMetricsPayload({
      success: true,
      result: {
        backlog_count: 4,
        backlog_bytes: 512,
        oldest_message_timestamp_ms: 1_786_837_200_000,
      },
    }),
    {
      backlogCount: 4,
      backlogBytes: 512,
      oldestMessageTimestampMs: 1_786_837_200_000,
    },
  );
  for (const payload of [
    null,
    { success: false, result: {} },
    { success: true, result: { backlog_count: -1, backlog_bytes: 0, oldest_message_timestamp_ms: 0 } },
    { success: true, result: { backlog_count: 0, backlog_bytes: "0", oldest_message_timestamp_ms: 0 } },
  ]) {
    assert.throws(() => parseQueueMetricsPayload(payload));
  }
});

test("source boundary contains no Queue message mutation or automatic stability decision", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /GRAPHQL_QUERY=QUEUE_MESSAGE_OPERATIONS_ONLY/);
  assert.match(source, /REST_METHOD=GET_ONLY/);
  assert.match(source, /CLOUDFLARE_MUTATION=NO/);
  assert.match(source, /STABILITY_DECISION=NOT_AUTOMATIC/);
  assert.match(source, /method: "GET"/);
  assert.match(source, /method: "POST"/); // GraphQL queries use HTTP POST while remaining read-only.
  assert.doesNotMatch(source, /\/messages(?:\/|[`"'])/);
  assert.doesNotMatch(source, /\bmutation\s+[A-Za-z]/);
  assert.doesNotMatch(source, /cfWrite|wrangler.*deploy|d1.*execute/i);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*apiToken/);
});
