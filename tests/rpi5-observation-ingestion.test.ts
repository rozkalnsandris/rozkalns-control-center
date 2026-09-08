import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  Rpi5ObservationReplayClaimError,
  type Rpi5ObservationReplayD1DatabaseLike,
  type Rpi5ObservationReplayD1PreparedStatementLike,
  type Rpi5ObservationReplayD1RunResultLike,
} from "../src/integrations/cloudflare/d1-rpi5-observation-replay-store.js";
import {
  ingestAuthenticatedRpi5Observation,
  Rpi5ObservationIngestionError,
} from "../src/integrations/cloudflare/rpi5-observation-ingestion.js";
import { ProductionVisibilityError } from "../src/shared/production-visibility.js";
import {
  buildRpi5ObservationSigningInput,
  RPI5_OBSERVATION_TRANSPORT_VERSION,
  Rpi5ObservationTransportError,
  type Rpi5ObservationUnsignedMetadata,
} from "../src/shared/rpi5-observation-transport.js";

const SENT_AT = "2026-09-08T07:30:00.000Z";
const NOW = "2026-09-08T07:34:00.000Z";
const DELIVERY_ID = "123e4567-e89b-42d3-a456-426614174000";
const KEY_ID = "rpi5-prod-2026-09";

const validPayloadObject = {
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

class FakeReplayDatabase implements Rpi5ObservationReplayD1DatabaseLike {
  readonly result: Rpi5ObservationReplayD1RunResultLike;
  prepareCalls = 0;
  query: string | null = null;
  boundValues: readonly unknown[] = [];

  constructor(result: Rpi5ObservationReplayD1RunResultLike) {
    this.result = result;
  }

  prepare(query: string): Rpi5ObservationReplayD1PreparedStatementLike {
    this.prepareCalls += 1;
    this.query = query;
    const database = this;
    const statement: Rpi5ObservationReplayD1PreparedStatementLike = {
      bind(...values: readonly unknown[]): Rpi5ObservationReplayD1PreparedStatementLike {
        database.boundValues = values;
        return statement;
      },
      async run(): Promise<Rpi5ObservationReplayD1RunResultLike> {
        return database.result;
      },
    };
    return statement;
  }
}

function unsignedMetadata(): Rpi5ObservationUnsignedMetadata {
  return {
    version: RPI5_OBSERVATION_TRANSPORT_VERSION,
    deliveryId: DELIVERY_ID,
    sentAt: SENT_AT,
    keyId: KEY_ID,
  };
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
}

async function signedMetadata(
  privateKey: CryptoKey,
  payload: Uint8Array,
): Promise<Rpi5ObservationUnsignedMetadata & { readonly signature: string }> {
  const metadata = unsignedMetadata();
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    copyToArrayBuffer(buildRpi5ObservationSigningInput(metadata, payload)),
  );
  return {
    ...metadata,
    signature: Buffer.from(signature).toString("base64url"),
  };
}

function transportError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Rpi5ObservationTransportError && error.code === code;
}

function replayError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Rpi5ObservationReplayClaimError && error.code === code;
}

function ingestionError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Rpi5ObservationIngestionError && error.code === code;
}

test("verifies, claims, then parses and normalizes one signed observation", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode(JSON.stringify(validPayloadObject));
  const metadata = await signedMetadata(keyPair.privateKey, payload);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  const result = await ingestAuthenticatedRpi5Observation({
    metadata,
    payload,
    verificationKey: keyPair.publicKey,
    replayDatabase,
    now: NOW,
  });

  assert.equal(result.projectId, "hermes-tech");
  assert.equal(result.productionAdapter, "rpi5");
  assert.equal(result.drift, "DRIFTED");
  assert.equal(replayDatabase.prepareCalls, 1);
  assert.match(replayDatabase.query ?? "", /INSERT INTO rpi5_observation_replay_claims/);
  assert.deepEqual(replayDatabase.boundValues, [
    `${KEY_ID}:${DELIVERY_ID}`,
    Date.parse("2026-09-08T07:35:00.000Z"),
    Date.parse(NOW),
  ]);
});

test("invalid signature fails before any durable replay claim", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode(JSON.stringify(validPayloadObject));
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata: { ...unsignedMetadata(), signature: "A".repeat(86) },
      payload,
      verificationKey: keyPair.publicKey,
      replayDatabase,
      now: NOW,
    }),
    transportError("INVALID_SIGNATURE"),
  );
  assert.equal(replayDatabase.prepareCalls, 0);
});

test("active replay fails before malformed signed payload parsing", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode("{not-json");
  const metadata = await signedMetadata(keyPair.privateKey, payload);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 0 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata,
      payload,
      verificationKey: keyPair.publicKey,
      replayDatabase,
      now: NOW,
    }),
    replayError("ACTIVE_REPLAY"),
  );
  assert.equal(replayDatabase.prepareCalls, 1);
});

test("malformed signed payload fails closed after a successful durable claim", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode("{not-json");
  const metadata = await signedMetadata(keyPair.privateKey, payload);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata,
      payload,
      verificationKey: keyPair.publicKey,
      replayDatabase,
      now: NOW,
    }),
    ingestionError("INVALID_PAYLOAD"),
  );
  assert.equal(replayDatabase.prepareCalls, 1);
});

test("strict sanitized consumer remains authoritative after signature and replay gates", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode(
    JSON.stringify({ ...validPayloadObject, protectedHost: "forbidden" }),
  );
  const metadata = await signedMetadata(keyPair.privateKey, payload);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata,
      payload,
      verificationKey: keyPair.publicKey,
      replayDatabase,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof ProductionVisibilityError && error.code === "UNEXPECTED_FIELD",
  );
  assert.equal(replayDatabase.prepareCalls, 1);
});

test("authenticated observation composition stays unwired from Worker and Wrangler", () => {
  const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
  const source = readFileSync(
    resolve(process.cwd(), "src/integrations/cloudflare/rpi5-observation-ingestion.ts"),
    "utf8",
  );

  assert.equal(workerIndex.includes("rpi5-observation-ingestion"), false);
  for (const binding of [
    "RPI5_OBSERVATION_PUBLIC_KEY",
    "RPI5_OBSERVATION_KEY_ID",
    "RPI5_OBSERVATION_REPLAY_STORE",
  ]) {
    assert.equal(wranglerConfig.includes(binding), false, `unexpected live binding: ${binding}`);
  }

  assert.match(source, /verifyRpi5ObservationDeliverySignature/);
  assert.match(source, /claimRpi5ObservationReplay/);
  assert.match(source, /normalizeSanitizedProductionVisibility/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\benv\s*\./);
  assert.doesNotMatch(source, /ssh|sudo/i);
});
