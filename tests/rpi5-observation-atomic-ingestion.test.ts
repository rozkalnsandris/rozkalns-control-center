import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  Rpi5ObservationAcceptanceError,
  type Rpi5ObservationAcceptanceResult,
} from "../src/integrations/cloudflare/d1-rpi5-observation-acceptance-store.js";
import type {
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import { Rpi5ObservationReplayClaimError } from "../src/integrations/cloudflare/d1-rpi5-observation-replay-store.js";
import {
  acceptAuthenticatedRpi5Observation,
  type Rpi5ObservationAtomicD1DatabaseLike,
} from "../src/integrations/cloudflare/rpi5-observation-atomic-ingestion.js";
import { Rpi5ObservationIngestionError } from "../src/integrations/cloudflare/rpi5-observation-ingestion.js";
import { ProductionVisibilityError } from "../src/shared/production-visibility.js";
import {
  buildRpi5ObservationSigningInput,
  RPI5_OBSERVATION_TRANSPORT_VERSION,
  Rpi5ObservationTransportError,
  type Rpi5ObservationUnsignedMetadata,
} from "../src/shared/rpi5-observation-transport.js";
import {
  RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION,
  Rpi5ObservationVerificationKeyRegistryError,
} from "../src/shared/rpi5-observation-verification-keys.js";

const SENT_AT = "2026-09-08T07:30:00.000Z";
const NOW = "2026-09-08T07:34:00.000Z";
const DELIVERY_ID = "123e4567-e89b-42d3-a456-426614174000";
const KEY_ID = "rpi5-prod-2026-09";

const VALID_PAYLOAD = {
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

interface PreparedCall {
  readonly query: string;
  values: readonly unknown[];
}

function result(changes: number): D1RunResultLike {
  return { success: true, meta: { changes }, results: [] };
}

class FakeAtomicDatabase implements Rpi5ObservationAtomicD1DatabaseLike {
  readonly prepared: PreparedCall[] = [];
  batchCalls = 0;
  runCalls = 0;

  constructor(
    private readonly batchResults: readonly D1RunResultLike[] = [result(1), result(1)],
    private readonly runResult: D1RunResultLike = result(1),
  ) {}

  prepare(query: string): D1PreparedStatementLike {
    const call: PreparedCall = { query, values: [] };
    this.prepared.push(call);
    const statement: D1PreparedStatementLike = {
      bind: (...values: readonly unknown[]): D1PreparedStatementLike => {
        call.values = values;
        return statement;
      },
      run: async <Row = Record<string, unknown>>(): Promise<D1RunResultLike<Row>> => {
        this.runCalls += 1;
        return this.runResult as D1RunResultLike<Row>;
      },
    };
    return statement;
  }

  async batch(_statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]> {
    this.batchCalls += 1;
    return [...this.batchResults];
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

async function verificationKeyRegistry(publicKey: CryptoKey) {
  return {
    version: RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION,
    keys: [
      {
        keyId: KEY_ID,
        publicKeyBase64url: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString(
          "base64url",
        ),
      },
    ],
  };
}

async function signedMetadata(privateKey: CryptoKey, payload: Uint8Array) {
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

async function fixture(payloadObject: unknown = VALID_PAYLOAD) {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode(JSON.stringify(payloadObject));
  return {
    keyPair,
    payload,
    metadata: await signedMetadata(keyPair.privateKey, payload),
    registry: await verificationKeyRegistry(keyPair.publicKey),
  };
}

function acceptanceError(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Rpi5ObservationAcceptanceError && error.code === code;
}

function replayError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Rpi5ObservationReplayClaimError && error.code === code;
}

async function acceptWith(
  database: FakeAtomicDatabase,
  payloadObject: unknown = VALID_PAYLOAD,
): Promise<Rpi5ObservationAcceptanceResult> {
  const data = await fixture(payloadObject);
  return acceptAuthenticatedRpi5Observation({
    metadata: data.metadata,
    payload: data.payload,
    verificationKeyRegistry: data.registry,
    database,
    now: NOW,
  });
}

test("valid signed observation uses one atomic claim+projection batch and reports STORED", async () => {
  const database = new FakeAtomicDatabase([result(1), result(1)]);

  assert.equal(await acceptWith(database), "STORED");
  assert.equal(database.batchCalls, 1);
  assert.equal(database.runCalls, 0);
  assert.equal(database.prepared.length, 2);
  assert.match(database.prepared[0]?.query ?? "", /INSERT INTO rpi5_observation_replay_claims/);
  assert.match(database.prepared[1]?.query ?? "", /INSERT INTO rpi5_production_visibility/);
  assert.match(database.prepared[1]?.query ?? "", /claim_token = \?4/);
  assert.equal(database.prepared[0]?.values[0], `${KEY_ID}:${DELIVERY_ID}`);
});

test("valid signed non-newer observation still consumes replay identity atomically", async () => {
  const database = new FakeAtomicDatabase([result(1), result(0)]);

  assert.equal(await acceptWith(database), "NOT_NEWER");
  assert.equal(database.batchCalls, 1);
  assert.equal(database.runCalls, 0);
});

test("valid active replay cannot write projection", async () => {
  const database = new FakeAtomicDatabase([result(0), result(0)]);

  await assert.rejects(acceptWith(database), acceptanceError("ACTIVE_REPLAY"));
  assert.equal(database.batchCalls, 1);
  assert.equal(database.runCalls, 0);
});

test("unknown key and invalid signature fail before prepare, run or batch", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode(JSON.stringify(VALID_PAYLOAD));
  const registry = await verificationKeyRegistry(keyPair.publicKey);

  const unknownKeyDatabase = new FakeAtomicDatabase();
  await assert.rejects(
    acceptAuthenticatedRpi5Observation({
      metadata: {
        ...(await signedMetadata(keyPair.privateKey, payload)),
        keyId: "unknown-key",
      },
      payload,
      verificationKeyRegistry: registry,
      database: unknownKeyDatabase,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof Rpi5ObservationVerificationKeyRegistryError &&
      error.code === "UNKNOWN_KEY_ID",
  );
  assert.equal(unknownKeyDatabase.prepared.length, 0);
  assert.equal(unknownKeyDatabase.batchCalls, 0);
  assert.equal(unknownKeyDatabase.runCalls, 0);

  const invalidSignatureDatabase = new FakeAtomicDatabase();
  await assert.rejects(
    acceptAuthenticatedRpi5Observation({
      metadata: { ...unsignedMetadata(), signature: "A".repeat(86) },
      payload,
      verificationKeyRegistry: registry,
      database: invalidSignatureDatabase,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof Rpi5ObservationTransportError && error.code === "INVALID_SIGNATURE",
  );
  assert.equal(invalidSignatureDatabase.prepared.length, 0);
  assert.equal(invalidSignatureDatabase.batchCalls, 0);
  assert.equal(invalidSignatureDatabase.runCalls, 0);
});

test("first malformed signed payload is durably consumed without projection batch", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode("{not-json");
  const database = new FakeAtomicDatabase([result(1), result(1)], result(1));

  await assert.rejects(
    acceptAuthenticatedRpi5Observation({
      metadata: await signedMetadata(keyPair.privateKey, payload),
      payload,
      verificationKeyRegistry: await verificationKeyRegistry(keyPair.publicKey),
      database,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof Rpi5ObservationIngestionError && error.code === "INVALID_PAYLOAD",
  );
  assert.equal(database.runCalls, 1);
  assert.equal(database.batchCalls, 0);
  assert.equal(database.prepared.length, 1);
  assert.match(database.prepared[0]?.query ?? "", /INSERT INTO rpi5_observation_replay_claims/);
});

test("active replay takes precedence over malformed signed payload error", async () => {
  const keyPair = await generateKeyPair();
  const payload = new TextEncoder().encode("{not-json");
  const database = new FakeAtomicDatabase([result(1), result(1)], result(0));

  await assert.rejects(
    acceptAuthenticatedRpi5Observation({
      metadata: await signedMetadata(keyPair.privateKey, payload),
      payload,
      verificationKeyRegistry: await verificationKeyRegistry(keyPair.publicKey),
      database,
      now: NOW,
    }),
    replayError("ACTIVE_REPLAY"),
  );
  assert.equal(database.runCalls, 1);
  assert.equal(database.batchCalls, 0);
});

test("strict sanitized rejection is durably consumed and never projected", async () => {
  const data = await fixture({ ...VALID_PAYLOAD, protectedHost: "forbidden" });
  const database = new FakeAtomicDatabase([result(1), result(1)], result(1));

  await assert.rejects(
    acceptAuthenticatedRpi5Observation({
      metadata: data.metadata,
      payload: data.payload,
      verificationKeyRegistry: data.registry,
      database,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof ProductionVisibilityError && error.code === "UNEXPECTED_FIELD",
  );
  assert.equal(database.runCalls, 1);
  assert.equal(database.batchCalls, 0);
});

test("atomic runtime composition stays source-only and production activation remains absent", () => {
  const source = readFileSync(
    "src/integrations/cloudflare/rpi5-observation-atomic-ingestion.ts",
    "utf8",
  );
  const runtime = readFileSync("src/integrations/cloudflare/rpi5-observation-runtime.ts", "utf8");
  const wrangler = readFileSync("wrangler.jsonc", "utf8");

  assert.match(source, /authenticateRpi5ObservationTransport/);
  assert.match(source, /D1Rpi5ObservationAcceptanceStore/);
  assert.match(source, /claimRpi5ObservationReplay/);
  assert.match(runtime, /acceptAuthenticatedRpi5Observation/);

  for (const forbidden of [/\bfetch\s*\(/i, /\bssh\b/i, /\bsudo\b/i, /private[_-]?key/i]) {
    assert.doesNotMatch(`${source}\n${runtime}`, forbidden);
  }
  for (const binding of [
    "CONTROL_RPI5_OBSERVATION_INGEST_ENABLED",
    "CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS",
  ]) {
    assert.equal(wrangler.includes(binding), false, `unexpected production activation: ${binding}`);
  }
});
