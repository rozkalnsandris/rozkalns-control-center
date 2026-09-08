import assert from "node:assert/strict";
import test from "node:test";

import { Rpi5ObservationReplayClaimError } from "../src/integrations/cloudflare/d1-rpi5-observation-replay-store.js";
import { Rpi5ObservationIngestionError } from "../src/integrations/cloudflare/rpi5-observation-ingestion.js";
import type { Rpi5ObservationWorkerRuntime } from "../src/integrations/cloudflare/rpi5-observation-runtime.js";
import { ProductionVisibilityError } from "../src/shared/production-visibility.js";
import { Rpi5ObservationTransportError } from "../src/shared/rpi5-observation-transport.js";
import { Rpi5ObservationVerificationKeyRegistryError } from "../src/shared/rpi5-observation-verification-keys.js";
import {
  handleRpi5ObservationRequest,
  RPI5_OBSERVATION_ROUTE_PATH,
} from "../src/worker/rpi5-observation-route.js";

const NOW = "2026-09-08T07:34:00.000Z";
const VALID_HEADERS = {
  "x-rpi5-observation-version": "control-phase5-rpi5-observation-v1",
  "x-rpi5-observation-delivery-id": "123e4567-e89b-42d3-a456-426614174000",
  "x-rpi5-observation-sent-at": "2026-09-08T07:30:00.000Z",
  "x-rpi5-observation-key-id": "rpi5-prod-2026-09",
  "x-rpi5-observation-signature": "A".repeat(86),
} as const;

function request(
  body: BodyInit | null = "{}",
  headers: HeadersInit = VALID_HEADERS,
  method = "POST",
): Request {
  return new Request(`https://control.example${RPI5_OBSERVATION_ROUTE_PATH}`, {
    method,
    headers,
    ...(method === "POST" && body !== null ? { body } : {}),
  });
}

function runtime(
  ingest: Rpi5ObservationWorkerRuntime["ingest"] = async () => undefined,
): Rpi5ObservationWorkerRuntime {
  return { ingest };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("observation route is strict POST and fails closed when runtime is unavailable", async () => {
  const wrongMethod = await handleRpi5ObservationRequest(
    request(null, VALID_HEADERS, "GET"),
    NOW,
    runtime(),
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal(wrongMethod.headers.get("cache-control"), "no-store");
  assert.deepEqual(await json(wrongMethod), { error: "METHOD_NOT_ALLOWED" });

  const unavailable = await handleRpi5ObservationRequest(request(), NOW, null);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.deepEqual(await json(unavailable), { error: "OBSERVATION_INGEST_UNAVAILABLE" });
});

test("observation route requires all five transport metadata headers before ingest", async () => {
  let ingests = 0;
  const headers = new Headers(VALID_HEADERS);
  headers.delete("x-rpi5-observation-key-id");

  const response = await handleRpi5ObservationRequest(
    request("{}", headers),
    NOW,
    runtime(async () => {
      ingests += 1;
    }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await json(response), { error: "INVALID_OBSERVATION_METADATA" });
  assert.equal(ingests, 0);
});

test("observation route rejects empty and over-limit raw bodies before ingest", async () => {
  let ingests = 0;
  const workerRuntime = runtime(async () => {
    ingests += 1;
  });

  const empty = await handleRpi5ObservationRequest(request(""), NOW, workerRuntime);
  assert.equal(empty.status, 400);
  assert.deepEqual(await json(empty), { error: "INVALID_OBSERVATION_PAYLOAD" });

  const oversized = await handleRpi5ObservationRequest(
    request(new Blob([new Uint8Array(16 * 1024 + 1)])),
    NOW,
    workerRuntime,
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await json(oversized), { error: "OBSERVATION_PAYLOAD_TOO_LARGE" });
  assert.equal(ingests, 0);
});

test("observation route passes exact metadata and raw bytes to runtime and returns bounded acceptance", async () => {
  const payloadText = '{"projectId":"hermes-tech"}';
  let observedMetadata: unknown = null;
  let observedPayload: Uint8Array | null = null;
  let observedNow: string | null = null;

  const response = await handleRpi5ObservationRequest(
    request(payloadText),
    NOW,
    runtime(async (metadata, payload, now) => {
      observedMetadata = metadata;
      observedPayload = payload;
      observedNow = now;
    }),
  );

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await json(response), { status: "AUTHENTICATED_AND_CLAIMED" });
  assert.deepEqual(observedMetadata, {
    version: VALID_HEADERS["x-rpi5-observation-version"],
    deliveryId: VALID_HEADERS["x-rpi5-observation-delivery-id"],
    sentAt: VALID_HEADERS["x-rpi5-observation-sent-at"],
    keyId: VALID_HEADERS["x-rpi5-observation-key-id"],
    signature: VALID_HEADERS["x-rpi5-observation-signature"],
  });
  assert.equal(new TextDecoder().decode(observedPayload ?? new Uint8Array()), payloadText);
  assert.equal(observedNow, NOW);
});

test("observation route collapses authentication failures without exposing key details", async () => {
  for (const error of [
    new Rpi5ObservationVerificationKeyRegistryError("UNKNOWN_KEY_ID"),
    new Rpi5ObservationVerificationKeyRegistryError("INVALID_PUBLIC_KEY"),
    new Rpi5ObservationTransportError("INVALID_SIGNATURE"),
    new Rpi5ObservationTransportError("STALE_DELIVERY"),
  ]) {
    const response = await handleRpi5ObservationRequest(
      request(),
      NOW,
      runtime(async () => {
        throw error;
      }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await json(response), { error: "OBSERVATION_AUTHENTICATION_FAILED" });
  }
});

test("observation route keeps replay, payload and infrastructure failures distinct but bounded", async () => {
  const cases: readonly [Error, number, string][] = [
    [new Rpi5ObservationReplayClaimError("ACTIVE_REPLAY"), 409, "OBSERVATION_REPLAYED"],
    [new Rpi5ObservationReplayClaimError("D1_FAILURE"), 503, "OBSERVATION_INGEST_UNAVAILABLE"],
    [new Rpi5ObservationIngestionError("INVALID_PAYLOAD"), 400, "INVALID_OBSERVATION_PAYLOAD"],
    [new ProductionVisibilityError("UNEXPECTED_FIELD"), 400, "INVALID_OBSERVATION_PAYLOAD"],
    [new Error("unexpected internal failure"), 503, "OBSERVATION_INGEST_UNAVAILABLE"],
  ];

  for (const [error, expectedStatus, expectedCode] of cases) {
    const response = await handleRpi5ObservationRequest(
      request(),
      NOW,
      runtime(async () => {
        throw error;
      }),
    );
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await json(response), { error: expectedCode });
  }
});
