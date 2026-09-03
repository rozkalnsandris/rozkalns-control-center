import assert from "node:assert/strict";
import test from "node:test";

import {
  withWorkerQueueLogging,
  withWorkerRequestLogging,
  type WorkerOperationLogRecord,
} from "../src/worker/structured-logging.js";

function clock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

test("request logs contain only fixed sanitized fields for success and HTTP errors", async () => {
  const records: WorkerOperationLogRecord[] = [];
  const secrets = ["query-secret", "bearer-secret", "cookie-secret", "review-body-secret", "hostile-ray-secret"];
  const request = new Request("https://control.example/api/github/merge?token=query-secret", {
    method: "POST",
    headers: {
      Authorization: "Bearer bearer-secret",
      Cookie: "CF_Authorization=cookie-secret",
      "CF-Ray": "hostile-ray-secret",
    },
    body: "review-body-secret",
  });
  const response = await withWorkerRequestLogging(
    request,
    "version_123",
    async () => Response.json({ error: "FAILED", protected: "response-secret" }, { status: 503 }),
    { nowMs: clock(1_000, 1_014), sink: (record) => records.push(record) },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(records, [{
    event: "control.worker.operation",
    route: "GITHUB_MERGE",
    method: "POST",
    status: 503,
    outcome: "SERVER_ERROR",
    errorCode: "HTTP_SERVER_ERROR",
    durationMs: 14,
    workerVersion: "version_123",
    correlationId: null,
    messageCount: null,
  }]);
  const serialized = JSON.stringify(records);
  for (const secret of [...secrets, "response-secret"]) assert.equal(serialized.includes(secret), false);
});

test("request logs use safe correlation evidence and never reflect exception details", async () => {
  const records: WorkerOperationLogRecord[] = [];
  const request = new Request("https://control.example/api/health", {
    headers: { "CF-Ray": "89abcdef01234567-FRA" },
  });
  const protectedException = new Error("private-key-material");

  await assert.rejects(
    () => withWorkerRequestLogging(request, "invalid version value", async () => { throw protectedException; }, {
      nowMs: clock(10, 15),
      sink: (record) => records.push(record),
    }),
    (error: unknown) => error === protectedException,
  );

  assert.deepEqual(records, [{
    event: "control.worker.operation",
    route: "HEALTH",
    method: "GET",
    status: null,
    outcome: "FAILED",
    errorCode: "UNCAUGHT_ERROR",
    durationMs: 5,
    workerVersion: null,
    correlationId: "89abcdef01234567-FRA",
    messageCount: null,
  }]);
  assert.equal(JSON.stringify(records).includes("private-key-material"), false);
});

test("Queue logs never inspect unknown names, message bodies or exception details", async () => {
  const records: WorkerOperationLogRecord[] = [];
  const protectedException = new Error("webhook-signature-secret");
  const batch = {
    queue: "private-queue-secret",
    messages: [{ body: "raw-webhook-secret" }],
  };

  await assert.rejects(
    () => withWorkerQueueLogging(batch, "queue-version", async () => { throw protectedException; }, {
      nowMs: clock(200, 209),
      sink: (record) => records.push(record),
    }),
    (error: unknown) => error === protectedException,
  );

  assert.deepEqual(records, [{
    event: "control.worker.operation",
    route: "QUEUE_UNKNOWN",
    method: "QUEUE",
    status: null,
    outcome: "FAILED",
    errorCode: "QUEUE_PROCESSING_ERROR",
    durationMs: 9,
    workerVersion: "queue-version",
    correlationId: null,
    messageCount: 1,
  }]);
  const serialized = JSON.stringify(records);
  for (const secret of ["private-queue-secret", "raw-webhook-secret", "webhook-signature-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("logging sink failure cannot change request behavior", async () => {
  const response = await withWorkerRequestLogging(
    new Request("https://control.example/api/health"),
    null,
    async () => new Response(null, { status: 204 }),
    { sink: () => { throw new Error("telemetry unavailable"); } },
  );
  assert.equal(response.status, 204);
});
