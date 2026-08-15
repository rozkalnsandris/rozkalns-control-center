const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class QueueRuntimeIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QueueRuntimeIdentityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new QueueRuntimeIdentityError(code, message);
}

function requiredOpaqueId(value, code, label) {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    fail(code, `${label} is missing or invalid`);
  }
  return value;
}

export function exactQueueByName(queues, name, expectedId = "") {
  if (!Array.isArray(queues)) fail("QUEUE_INVENTORY_INVALID", "Queue inventory is not an array");
  const matches = queues.filter(
    (queue) => queue?.queue_name === name && (expectedId === "" || queue?.queue_id === expectedId),
  );
  if (matches.length !== 1) fail("QUEUE_AMBIGUOUS", `${name} was not uniquely identified`);
  requiredOpaqueId(matches[0]?.queue_id, "QUEUE_ID_INVALID", `${name} queue id`);
  return matches[0];
}

export function assertWorkerProducer(queue, workerName) {
  const producers = Array.isArray(queue?.producers) ? queue.producers : [];
  const workerProducers = producers.filter(
    (producer) => producer?.type === "worker" && producer?.script === workerName,
  );
  if (workerProducers.length !== 1 || producers.length !== 1) {
    fail("QUEUE_PRODUCER_INVALID", "Queue does not have exactly the reviewed Worker producer");
  }
  return workerProducers[0];
}

export function assertNoQueueProducers(queue) {
  const producers = Array.isArray(queue?.producers) ? queue.producers : [];
  if (producers.length !== 0) fail("QUEUE_PRODUCER_UNEXPECTED", "Queue must not have a producer");
}

export function assertWorkerConsumer(consumer, expected) {
  if (consumer?.type !== "worker") fail("QUEUE_CONSUMER_TYPE", "Queue consumer must be a Worker consumer");
  requiredOpaqueId(consumer?.consumer_id, "QUEUE_CONSUMER_ID", "Queue consumer id");
  if (consumer?.queue_name !== expected.queueName) {
    fail("QUEUE_CONSUMER_QUEUE", "Queue consumer queue name changed");
  }

  // Cloudflare documents script_name as optional in Queue consumer responses. If the
  // API supplies a non-null value, it remains a strong attestation and must match.
  // If it is omitted/null, identity is instead bounded by the unique Worker
  // consumer, exact queue/settings, reviewed source config and Queue producer
  // evidence checked by the reconciliation gate.
  if (consumer?.script_name !== undefined && consumer?.script_name !== null) {
    if (typeof consumer.script_name !== "string" || consumer.script_name.length === 0) {
      fail("QUEUE_CONSUMER_SCRIPT_INVALID", "Queue consumer script_name was present but invalid");
    }
    if (consumer.script_name !== expected.workerName) {
      fail("QUEUE_CONSUMER_SCRIPT_MISMATCH", "Queue consumer script_name does not match the reviewed Worker");
    }
  }

  const settings = consumer?.settings ?? {};
  if (
    settings.batch_size !== expected.batchSize ||
    settings.max_wait_time_ms !== expected.maxWaitTimeMs ||
    settings.max_retries !== expected.maxRetries ||
    settings.max_concurrency !== expected.maxConcurrency ||
    settings.retry_delay !== expected.retryDelay
  ) {
    fail("QUEUE_CONSUMER_SETTINGS", "Queue consumer settings do not match the reviewed bounded policy");
  }

  if (expected.deadLetterQueue) {
    if (consumer?.dead_letter_queue !== expected.deadLetterQueue) {
      fail("QUEUE_CONSUMER_DLQ", "Queue consumer dead-letter target changed");
    }
  } else if (consumer?.dead_letter_queue !== null && consumer?.dead_letter_queue !== undefined && consumer?.dead_letter_queue !== "") {
    fail("QUEUE_CONSUMER_UNEXPECTED_DLQ", "Queue consumer must not have a dead-letter target");
  }

  return consumer;
}

export function exactWorkerConsumer(consumers, expected, expectedId = "") {
  if (!Array.isArray(consumers)) fail("QUEUE_CONSUMER_INVENTORY_INVALID", "Queue consumer inventory is not an array");
  const matches = consumers.filter(
    (consumer) => consumer?.type === "worker" && (expectedId === "" || consumer?.consumer_id === expectedId),
  );
  if (matches.length !== 1 || consumers.length !== 1) {
    fail("QUEUE_CONSUMER_AMBIGUOUS", "Queue must have exactly one reviewed Worker consumer");
  }
  return assertWorkerConsumer(matches[0], expected);
}