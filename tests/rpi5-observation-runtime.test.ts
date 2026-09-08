import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  resolveRpi5ObservationRuntime,
  rpi5ObservationIngestEnabled,
  type Rpi5ObservationRuntimeBindings,
} from "../src/integrations/cloudflare/rpi5-observation-runtime.js";
import { Rpi5ObservationVerificationKeyRegistryError } from "../src/shared/rpi5-observation-verification-keys.js";

const REGISTRY = JSON.stringify({
  version: "control-phase5-rpi5-verification-keys-v1",
  keys: [
    {
      keyId: "rpi5-prod-2026-09",
      publicKeyBase64url: "A".repeat(43),
    },
  ],
});

function database() {
  let prepareCalls = 0;
  let batchCalls = 0;
  return {
    binding: {
      prepare() {
        prepareCalls += 1;
        throw new Error("test should fail before D1 query");
      },
      async batch() {
        batchCalls += 1;
        throw new Error("test should fail before D1 batch");
      },
    },
    prepareCalls: () => prepareCalls,
    batchCalls: () => batchCalls,
  };
}

test("observation runtime opt-in must be exactly true before dependent bindings are inspected", () => {
  for (const value of [undefined, null, false, true, "false", "TRUE", "true ", " true", 1]) {
    assert.equal(rpi5ObservationIngestEnabled(value), false);
  }
  assert.equal(rpi5ObservationIngestEnabled("true"), true);

  let inspected = 0;
  const bindings = {
    CONTROL_RPI5_OBSERVATION_INGEST_ENABLED: "false",
    get CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS() {
      inspected += 1;
      throw new Error("must stay dormant");
    },
    get CONTROL_DB() {
      inspected += 1;
      throw new Error("must stay dormant");
    },
  } as Rpi5ObservationRuntimeBindings;

  assert.deepEqual(resolveRpi5ObservationRuntime(bindings), { status: "DISABLED" });
  assert.equal(inspected, 0);
});

test("enabled runtime fails closed for missing or malformed dependencies without D1 queries", () => {
  const db = database();

  assert.deepEqual(
    resolveRpi5ObservationRuntime({
      CONTROL_RPI5_OBSERVATION_INGEST_ENABLED: "true",
      CONTROL_DB: db.binding,
    }),
    { status: "INVALID" },
  );
  assert.deepEqual(
    resolveRpi5ObservationRuntime({
      CONTROL_RPI5_OBSERVATION_INGEST_ENABLED: "true",
      CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS: "not-json",
      CONTROL_DB: db.binding,
    }),
    { status: "INVALID" },
  );
  assert.deepEqual(
    resolveRpi5ObservationRuntime({
      CONTROL_RPI5_OBSERVATION_INGEST_ENABLED: "true",
      CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS: JSON.stringify({
        version: "wrong",
        keys: [],
      }),
      CONTROL_DB: db.binding,
    }),
    { status: "INVALID" },
  );
  assert.deepEqual(
    resolveRpi5ObservationRuntime({
      CONTROL_RPI5_OBSERVATION_INGEST_ENABLED: "true",
      CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS: REGISTRY,
      CONTROL_DB: { prepare() {} },
    }),
    { status: "INVALID" },
  );
  assert.equal(db.prepareCalls(), 0);
  assert.equal(db.batchCalls(), 0);
});

test("ready runtime delegates to strict atomic ingestion and unknown key fails before D1", async () => {
  const db = database();
  const resolution = resolveRpi5ObservationRuntime({
    CONTROL_RPI5_OBSERVATION_INGEST_ENABLED: "true",
    CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS: REGISTRY,
    CONTROL_DB: db.binding,
  });

  assert.equal(resolution.status, "READY");
  if (resolution.status !== "READY") return;

  await assert.rejects(
    () =>
      resolution.runtime.ingest(
        {
          version: "control-phase5-rpi5-observation-v1",
          deliveryId: "123e4567-e89b-42d3-a456-426614174000",
          sentAt: "2026-09-08T07:30:00.000Z",
          keyId: "unknown-key",
          signature: "A".repeat(86),
        },
        new TextEncoder().encode("{}"),
        "2026-09-08T07:34:00.000Z",
      ),
    (error: unknown) =>
      error instanceof Rpi5ObservationVerificationKeyRegistryError &&
      error.code === "UNKNOWN_KEY_ID",
  );
  assert.equal(db.prepareCalls(), 0);
  assert.equal(db.batchCalls(), 0);
});

test("Worker wiring is source-present while production activation and key values remain absent", async () => {
  const [worker, wrangler, runtimeSource] = await Promise.all([
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
    readFile("src/integrations/cloudflare/rpi5-observation-runtime.ts", "utf8"),
  ]);

  assert.match(worker, /RPI5_OBSERVATION_ROUTE_PATH/);
  assert.match(worker, /resolveRpi5ObservationRuntime/);
  assert.match(worker, /handleRpi5ObservationRequest/);
  assert.match(runtimeSource, /acceptAuthenticatedRpi5Observation/);
  assert.match(runtimeSource, /typeof database\.batch !== "function"/);

  for (const binding of [
    "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED",
    "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS",
  ]) {
    assert.equal(wrangler.includes(binding), false, `unexpected production activation: ${binding}`);
  }
  assert.equal(wrangler.includes("RPI5_OBSERVATION_PUBLIC_KEY"), false);
  assert.equal(wrangler.includes("RPI5_OBSERVATION_KEY_ID"), false);
});
