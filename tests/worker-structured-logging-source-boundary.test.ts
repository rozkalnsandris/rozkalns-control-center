import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Worker request and Queue entrypoints use the sanitized structured logging boundary", async () => {
  const [logger, worker] = await Promise.all([
    readFile("src/worker/structured-logging.ts", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
  ]);
  const implementation = logger
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  assert.match(implementation, /new URL\(request\.url\)\.pathname/);
  assert.match(implementation, /request\.headers\.get\("cf-ray"\)/);
  assert.doesNotMatch(implementation, /request\.(?:json|text|arrayBuffer|formData)\(/);
  assert.doesNotMatch(implementation, /response\.(?:json|text|arrayBuffer|formData)\(/);
  assert.doesNotMatch(implementation, /URLSearchParams|\.searchParams|\.search\b/);
  assert.doesNotMatch(implementation, /authorization|cookie|access-jwt|webhook-signature|review-body/i);
  assert.match(worker, /withWorkerRequestLogging/);
  assert.match(worker, /withWorkerQueueLogging/);
});
