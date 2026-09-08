import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildRpi5ObservationSigningInput,
  normalizeRpi5ObservationDeliveryMetadata,
  RPI5_OBSERVATION_TRANSPORT_VERSION,
  Rpi5ObservationTransportError,
  type Rpi5ObservationUnsignedMetadata,
  verifyRpi5ObservationDeliverySignature,
} from "../src/shared/rpi5-observation-transport.js";
import {
  normalizeSanitizedProductionVisibility,
  ProductionVisibilityError,
  SANITIZED_PRODUCTION_VISIBILITY_FIELDS,
} from "../src/shared/production-visibility.js";

const SENT_AT = "2026-09-08T07:30:00.000Z";
const NOW = "2026-09-08T07:34:00.000Z";
const DELIVERY_ID = "123e4567-e89b-42d3-a456-426614174000";
const KEY_ID = "rpi5-prod-2026-09";

const payloadObject = {
  projectId: "hermes-tech",
  repository: "rozkalnsandris/hermes-tech",
  mainSha: "1111111111111111111111111111111111111111",
  productionSha: "2222222222222222222222222222222222222222",
  deployImpact: "MANUAL_ROLLOUT_REQUIRED",
  runtime: "HEALTHY",
  health: "PASS",
  rollback: "AVAILABLE",
  blockerCodes: ["PRODUCTION_SHA_BEHIND_MAIN"],
  observedAt: SENT_AT,
} as const;
const payload = new TextEncoder().encode(JSON.stringify(payloadObject));

function unsignedMetadata(
  overrides: Partial<Rpi5ObservationUnsignedMetadata> = {},
): Rpi5ObservationUnsignedMetadata {
  return {
    version: RPI5_OBSERVATION_TRANSPORT_VERSION,
    deliveryId: DELIVERY_ID,
    sentAt: SENT_AT,
    keyId: KEY_ID,
    ...overrides,
  };
}

function transportError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Rpi5ObservationTransportError && error.code === code;
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
}

async function sign(
  privateKey: CryptoKey,
  metadata: Rpi5ObservationUnsignedMetadata,
  payloadBytes: Uint8Array,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    buildRpi5ObservationSigningInput(metadata, payloadBytes),
  );
  return Buffer.from(signature).toString("base64url");
}

test("verifies an Ed25519 signature over delivery metadata and exact raw payload bytes", async () => {
  const keyPair = await generateKeyPair();
  const metadata = unsignedMetadata();
  const signature = await sign(keyPair.privateKey, metadata, payload);

  const result = await verifyRpi5ObservationDeliverySignature(
    { ...metadata, signature },
    payload,
    keyPair.publicKey,
    NOW,
  );

  assert.equal(result.metadata.deliveryId, DELIVERY_ID);
  assert.equal(result.metadata.keyId, KEY_ID);
  assert.equal(result.replayKey, `${KEY_ID}:${DELIVERY_ID}`);
  assert.equal(result.replayExpiresAt, "2026-09-08T07:35:00.000Z");
});

test("fails closed when signed payload bytes or signed delivery identity change", async () => {
  const keyPair = await generateKeyPair();
  const metadata = unsignedMetadata();
  const signature = await sign(keyPair.privateKey, metadata, payload);
  const signed = { ...metadata, signature };

  const tamperedPayload = new Uint8Array(payload);
  tamperedPayload[tamperedPayload.length - 1] ^= 1;
  await assert.rejects(
    verifyRpi5ObservationDeliverySignature(signed, tamperedPayload, keyPair.publicKey, NOW),
    transportError("INVALID_SIGNATURE"),
  );

  await assert.rejects(
    verifyRpi5ObservationDeliverySignature(
      { ...signed, deliveryId: "123e4567-e89b-42d3-b456-426614174001" },
      payload,
      keyPair.publicKey,
      NOW,
    ),
    transportError("INVALID_SIGNATURE"),
  );
});

test("strict delivery metadata rejects extras, malformed identifiers, and stale or future timestamps", () => {
  const signature = "A".repeat(86);

  assert.throws(
    () => normalizeRpi5ObservationDeliveryMetadata({ ...unsignedMetadata(), signature, host: "rpi5" }, NOW),
    transportError("UNEXPECTED_FIELD"),
  );
  assert.throws(
    () =>
      normalizeRpi5ObservationDeliveryMetadata(
        { ...unsignedMetadata({ deliveryId: "not-a-delivery-id" }), signature },
        NOW,
      ),
    transportError("INVALID_INPUT"),
  );
  assert.throws(
    () =>
      normalizeRpi5ObservationDeliveryMetadata(
        { ...unsignedMetadata({ sentAt: "2026-09-08T07:28:59.999Z" }), signature },
        NOW,
      ),
    transportError("STALE_DELIVERY"),
  );
  assert.throws(
    () =>
      normalizeRpi5ObservationDeliveryMetadata(
        { ...unsignedMetadata({ sentAt: "2026-09-08T07:34:00.001Z" }), signature },
        NOW,
      ),
    transportError("STALE_DELIVERY"),
  );
});

test("transport metadata remains outside the strict ten-field sanitized payload", () => {
  assert.deepEqual(SANITIZED_PRODUCTION_VISIBILITY_FIELDS, [
    "projectId",
    "repository",
    "mainSha",
    "productionSha",
    "deployImpact",
    "runtime",
    "health",
    "rollback",
    "blockerCodes",
    "observedAt",
  ]);
  assert.equal(SANITIZED_PRODUCTION_VISIBILITY_FIELDS.length, 10);

  assert.throws(
    () =>
      normalizeSanitizedProductionVisibility(
        { ...payloadObject, deliveryId: DELIVERY_ID, signature: "transport-only" },
        NOW,
      ),
    (error: unknown) => error instanceof ProductionVisibilityError && error.code === "UNEXPECTED_FIELD",
  );
});

test("observation transport source stays unwired and grants no live RPi5 access path", () => {
  const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
  const source = readFileSync(
    resolve(process.cwd(), "src/shared/rpi5-observation-transport.ts"),
    "utf8",
  );

  assert.equal(workerIndex.includes("rpi5-observation-transport"), false);
  for (const binding of [
    "RPI5_OBSERVATION_PUBLIC_KEY",
    "RPI5_OBSERVATION_KEY_ID",
    "RPI5_OBSERVATION_REPLAY_STORE",
  ]) {
    assert.equal(wranglerConfig.includes(binding), false, `unexpected live binding: ${binding}`);
  }

  assert.match(source, /crypto\.subtle\.verify/);
  assert.match(source, /replayKey/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\benv\s*\./);
  assert.doesNotMatch(source, /ssh|sudo|INSERT|UPDATE|DELETE/i);
});
