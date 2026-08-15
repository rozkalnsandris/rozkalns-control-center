import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const helperUrl = pathToFileURL(resolve("scripts/cloudflare-queue-runtime-identity.mjs")).href;

function runHelper(body: string) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `import * as helper from ${JSON.stringify(helperUrl)};\n${body}`],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

const expectedMain = {
  queueName: "rozkalns-control-reconciliation",
  workerName: "rozkalns-control",
  batchSize: 10,
  maxWaitTimeMs: 5000,
  maxRetries: 3,
  maxConcurrency: 1,
  retryDelay: 30,
  deadLetterQueue: "rozkalns-control-reconciliation-dlq",
};

const observedMainConsumer = {
  consumer_id: "f33e736438b543c18dc7b58bb5eb126a",
  type: "worker",
  queue_name: "rozkalns-control-reconciliation",
  script_name: null,
  dead_letter_queue: "rozkalns-control-reconciliation-dlq",
  settings: {
    batch_size: 10,
    max_retries: 3,
    max_wait_time_ms: 5000,
    max_concurrency: 1,
    retry_delay: 30,
  },
};

test("accepts the observed Cloudflare worker consumer response when script_name is null", () => {
  const result = runHelper(`
    const consumer = helper.exactWorkerConsumer(
      ${JSON.stringify([observedMainConsumer])},
      ${JSON.stringify(expectedMain)}
    );
    console.log(consumer.consumer_id);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), observedMainConsumer.consumer_id);
});

test("accepts an exact script_name attestation when Cloudflare supplies it", () => {
  const withScript = { ...observedMainConsumer, script_name: "rozkalns-control" };
  const result = runHelper(`
    const consumer = helper.exactWorkerConsumer(
      ${JSON.stringify([withScript])},
      ${JSON.stringify(expectedMain)}
    );
    console.log(consumer.script_name);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "rozkalns-control");
});

test("fails closed when a non-null script_name identifies another Worker", () => {
  const conflicting = { ...observedMainConsumer, script_name: "other-worker" };
  const result = runHelper(`
    try {
      helper.exactWorkerConsumer(
        ${JSON.stringify([conflicting])},
        ${JSON.stringify(expectedMain)}
      );
      process.exitCode = 40;
    } catch (error) {
      console.log(error.code);
    }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "QUEUE_CONSUMER_SCRIPT_MISMATCH");
});

test("fails closed on duplicate consumers even if one consumer is otherwise valid", () => {
  const duplicate = { ...observedMainConsumer, consumer_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const result = runHelper(`
    try {
      helper.exactWorkerConsumer(
        ${JSON.stringify([observedMainConsumer, duplicate])},
        ${JSON.stringify(expectedMain)}
      );
      process.exitCode = 40;
    } catch (error) {
      console.log(error.code);
    }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "QUEUE_CONSUMER_AMBIGUOUS");
});

test("pins the exact queue policy and dead-letter target", () => {
  const wrongRetry = {
    ...observedMainConsumer,
    settings: { ...observedMainConsumer.settings, retry_delay: 31 },
  };
  const result = runHelper(`
    try {
      helper.exactWorkerConsumer(
        ${JSON.stringify([wrongRetry])},
        ${JSON.stringify(expectedMain)}
      );
      process.exitCode = 40;
    } catch (error) {
      console.log(error.code);
    }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "QUEUE_CONSUMER_SETTINGS");
});

test("proves the main Queue producer using the documented producers[].script field", () => {
  const queue = {
    queue_id: "31cf71912525401fa2a322b18fca26b2",
    queue_name: "rozkalns-control-reconciliation",
    producers: [{ type: "worker", script: "rozkalns-control" }],
  };
  const result = runHelper(`
    const exact = helper.exactQueueByName(${JSON.stringify([queue])}, "rozkalns-control-reconciliation");
    const producer = helper.assertWorkerProducer(exact, "rozkalns-control");
    console.log(producer.script);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "rozkalns-control");
});

test("DLQ policy accepts the observed platform-default retry_delay zero and no producer", () => {
  const queue = {
    queue_id: "4709d6ab73924fbdb3801610bbe5f384",
    queue_name: "rozkalns-control-reconciliation-dlq",
    producers: [],
  };
  const consumer = {
    consumer_id: "8672bcac4e214617bd404ba1a049c30e",
    type: "worker",
    queue_name: "rozkalns-control-reconciliation-dlq",
    script_name: null,
    dead_letter_queue: null,
    settings: {
      batch_size: 10,
      max_retries: 3,
      max_wait_time_ms: 5000,
      max_concurrency: 1,
      retry_delay: 0,
    },
  };
  const expected = {
    queueName: "rozkalns-control-reconciliation-dlq",
    workerName: "rozkalns-control",
    batchSize: 10,
    maxWaitTimeMs: 5000,
    maxRetries: 3,
    maxConcurrency: 1,
    retryDelay: 0,
  };
  const result = runHelper(`
    const exact = helper.exactQueueByName(${JSON.stringify([queue])}, "rozkalns-control-reconciliation-dlq");
    helper.assertNoQueueProducers(exact);
    const c = helper.exactWorkerConsumer(${JSON.stringify([consumer])}, ${JSON.stringify(expected)});
    console.log(c.consumer_id);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), consumer.consumer_id);
});