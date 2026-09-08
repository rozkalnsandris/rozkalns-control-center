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
import {
  normalizeRpi5ObservationVerificationKeyRegistry,
  RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION,
  Rpi5ObservationVerificationKeyRegistryError,
} from "../src/shared/rpi5-observation-verification-keys.js";

const SENT_AT = "2026-09-08T07:30:00.000Z";
const NOW = "2026-09-08T07:34:00.000Z";
const DELIVERY_ID = "123e4567-e89b-42d3-a456-426614174000";
const KEY_ID = "rpi5-prod-2026-09";
const ROTATED_KEY_ID = "rpi5-prod-2026-10";

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
    const statement: Rpi5ObservationReplayD1PreparedStatementLike = {
      bind: (...values: readonly unknown[]): Rpi5ObservationReplayD1PreparedStatementLike => {
        this.boundValues = values;
        return statement;
      },
      run: async (): Promise<Rpi5ObservationReplayD1RunResultLike> => this.result,
    };
    return statement;
  }
}

function unsignedMetadata(keyId = KEY_ID): Rpi5ObservationUnsignedMetadata {
  return {
    version: RPI5_OBSERVATION_TRANSPORT_VERSION,
    deliveryId: DELIVERY_ID,
    sentAt: SENT_AT,
    keyId,
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

async function verificationKeyRegistry(
  entries: readonly (readonly [string, CryptoKey])[],
): Promise<{
  readonly version: typeof RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION;
  readonly keys: readonly { readonly keyId: string; readonly publicKeyBase64url: string }[];
}> {
  const keys = await Promise.all(
    entries.map(async ([keyId, publicKey]) => ({
      keyId,
      publicKeyBase64url: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString(
        "base64url",
      ),
    })),
  );
  return {
    version: RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION,
    keys,
  };
}

async function signedMetadata(
  privateKey: CryptoKey,
  payload: Uint8Array,
  keyId = KEY_ID,
): Promise<Rpi5ObservationUnsignedMetadata & { readonly signature: string }> {
  const metadata = unsignedMetadata(keyId);
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

function registryError(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Rpi5ObservationVerificationKeyRegistryError && error.code === code;
}

function replayError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Rpi5ObservationReplayClaimError && error.code === code;
}

function ingestionError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Rpi5ObservationIngestionError && error.code === code;
}

test("verifies exact keyId, claims, then parses and normalizes one signed observation", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode(JSON.stringify(validPayloadObject));
  const metadata = await signedMetadata(keyPair.privateKey, payload);
  const verificationKeyRegistry = await verificationKeyRegistry([[KEY_ID, keyPair.publicKey]]);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  const result = await ingestAuthenticatedRpi5Observation({
    metadata,
    payload,
    verificationKeyRegistry,
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

test("unknown keyId fails closed before signature verification can claim replay state", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode(JSON.stringify(validPayloadObject));
  const metadata = await signedMetadata(keyPair.privateKey, payload, ROTATED_KEY_ID);
  const verificationKeyRegistry = await verificationKeyRegistry([[KEY_ID, keyPair.publicKey]]);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata,
      payload,
      verificationKeyRegistry,
      replayDatabase,
      now: NOW,
    }),
    registryError("UNKNOWN_KEY_ID"),
  );
  assert.equal(replayDatabase.prepareCalls, 0);
});

test("declared keyId cannot fall back to another valid registry key", async () => {
  const declaredKey = await generateKeyPair();
  const wrongSigner = await generateKeyPair();
  const payload = new TextEncoder().encode(JSON.stringify(validPayloadObject));
  const metadata = await signedMetadata(wrongSigner.privateKey, payload, KEY_ID);
  const verificationKeyRegistry = await verificationKeyRegistry([
    [KEY_ID, declaredKey.publicKey],
    [ROTATED_KEY_ID, wrongSigner.publicKey],
  ]);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata,
      payload,
      verificationKeyRegistry,
      replayDatabase,
      now: NOW,
    }),
    transportError("INVALID_SIGNATURE"),
  );
  assert.equal(replayDatabase.prepareCalls, 0);
});

test("bounded key rotation accepts either exact keyId without default selection", async () => {
  const firstKey = await generateKeyPair();
  const rotatedKey = await generateKeyPair();
  const payload = new TextEncoder().encode(JSON.stringify(validPayloadObject));
  const metadata = await signedMetadata(rotatedKey.privateKey, payload, ROTATED_KEY_ID);
  const verificationKeyRegistry = await verificationKeyRegistry([
    [KEY_ID, firstKey.publicKey],
    [ROTATED_KEY_ID, rotatedKey.publicKey],
  ]);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  const result = await ingestAuthenticatedRpi5Observation({
    metadata,
    payload,
    verificationKeyRegistry,
    replayDatabase,
    now: NOW,
  });

  assert.equal(result.projectId, "hermes-tech");
  assert.deepEqual(replayDatabase.boundValues, [
    `${ROTATED_KEY_ID}:${DELIVERY_ID}`,
    Date.parse("2026-09-08T07:35:00.000Z"),
    Date.parse(NOW),
  ]);
});

test("verification-key registry rejects duplicates, unknown fields, versions and malformed keys", async () => {
  const keyPair = await generateKeyPair();
  const validRegistry = await verificationKeyRegistry([[KEY_ID, keyPair.publicKey]]);
  const entry = validRegistry.keys[0];
  assert.ok(entry);

  assert.throws(
    () =>
      normalizeRpi5ObservationVerificationKeyRegistry({
        ...validRegistry,
        keys: [entry, entry],
      }),
    registryError("INVALID_REGISTRY"),
  );
  assert.throws(
    () =>
      normalizeRpi5ObservationVerificationKeyRegistry({
        ...validRegistry,
        unexpected: true,
      }),
    registryError("INVALID_REGISTRY"),
  );
  assert.throws(
    () =>
      normalizeRpi5ObservationVerificationKeyRegistry({
        ...validRegistry,
        version: "unsupported",
      }),
    registryError("INVALID_REGISTRY"),
  );
  assert.throws(
    () =>
      normalizeRpi5ObservationVerificationKeyRegistry({
        version: RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION,
        keys: [{ keyId: KEY_ID, publicKeyBase64url: "A".repeat(42) }],
      }),
    registryError("INVALID_PUBLIC_KEY"),
  );
});

test("invalid signature fails before any durable replay claim", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode(JSON.stringify(validPayloadObject));
  const verificationKeyRegistry = await verificationKeyRegistry([[KEY_ID, keyPair.publicKey]]);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata: { ...unsignedMetadata(), signature: "A".repeat(86) },
      payload,
      verificationKeyRegistry,
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
  const verificationKeyRegistry = await verificationKeyRegistry([[KEY_ID, keyPair.publicKey]]);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 0 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata,
      payload,
      verificationKeyRegistry,
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
  const verificationKeyRegistry = await verificationKeyRegistry([[KEY_ID, keyPair.publicKey]]);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata,
      payload,
      verificationKeyRegistry,
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
  const verificationKeyRegistry = await verificationKeyRegistry([[KEY_ID, keyPair.publicKey]]);
  const replayDatabase = new FakeReplayDatabase({ success: true, meta: { changes: 1 } });

  await assert.rejects(
    ingestAuthenticatedRpi5Observation({
      metadata,
      payload,
      verificationKeyRegistry,
      replayDatabase,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof ProductionVisibilityError && error.code === "UNEXPECTED_FIELD",
  );
  assert.equal(replayDatabase.prepareCalls, 1);
});

test("verification-key registry and ingestion stay unwired from Worker and Wrangler", () => {
  const workerIndex = readFileSync(resolve(process.cwd(), "src/worker/index.ts"), "utf8");
  const wranglerConfig = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
  const ingestionSource = readFileSync(
    resolve(process.cwd(), "src/integrations/cloudflare/rpi5-observation-ingestion.ts"),
    "utf8",
  );
  const registrySource = readFileSync(
    resolve(process.cwd(), "src/shared/rpi5-observation-verification-keys.ts"),
    "utf8",
  );

  assert.equal(workerIndex.includes("rpi5-observation-ingestion"), false);
  for (const binding of [
    "RPI5_OBSERVATION_PUBLIC_KEY",
    "RPI5_OBSERVATION_KEY_ID",
    "RPI5_OBSERVATION_VERIFICATION_KEYS",
    "RPI5_OBSERVATION_REPLAY_STORE",
  ]) {
    assert.equal(wranglerConfig.includes(binding), false, `unexpected live binding: ${binding}`);
  }

  assert.match(ingestionSource, /resolveRpi5ObservationVerificationKey/);
  assert.match(ingestionSource, /verifyRpi5ObservationDeliverySignature/);
  assert.match(ingestionSource, /claimRpi5ObservationReplay/);
  assert.match(ingestionSource, /normalizeSanitizedProductionVisibility/);
  assert.doesNotMatch(ingestionSource, /verificationKey:\s*CryptoKey/);
  for (const source of [ingestionSource, registrySource]) {
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /\benv\s*\./);
    assert.doesNotMatch(source, /ssh|sudo/i);
  }
});
