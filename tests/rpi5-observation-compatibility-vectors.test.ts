import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type {
  D1PreparedStatementLike,
  D1RunResultLike,
} from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import {
  acceptAuthenticatedRpi5Observation,
  type Rpi5ObservationAtomicD1DatabaseLike,
} from "../src/integrations/cloudflare/rpi5-observation-atomic-ingestion.js";
import {
  authenticateRpi5ObservationTransport,
  parseSignedRpi5ObservationPayload,
} from "../src/integrations/cloudflare/rpi5-observation-ingestion.js";
import {
  normalizeSanitizedProductionVisibility,
  type ProductionVisibilityReadModel,
} from "../src/shared/production-visibility.js";
import {
  MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS,
  RPI5_OBSERVATION_TRANSPORT_VERSION,
} from "../src/shared/rpi5-observation-transport.js";
import {
  normalizeRpi5ObservationVerificationKeyRegistry,
  RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION,
} from "../src/shared/rpi5-observation-verification-keys.js";

interface SignedVector {
  readonly id: string;
  readonly metadata: {
    readonly version: string;
    readonly deliveryId: string;
    readonly sentAt: string;
    readonly keyId: string;
    readonly signature: string;
  };
  readonly payloadUtf8: string;
}

interface CompatibilityFixture {
  readonly contractId: string;
  readonly transportVersion: string;
  readonly verificationKeyRegistryVersion: string;
  readonly signingDomain: string;
  readonly maxDeliveryAgeMs: number;
  readonly referenceNow: string;
  readonly keyRegistry: unknown;
  readonly signedVectors: readonly SignedVector[];
  readonly expectations: Record<string, Record<string, unknown>>;
  readonly acceptanceScenarios: readonly {
    readonly id: string;
    readonly vectorIds: readonly string[];
    readonly expected: readonly string[];
  }[];
  readonly safety: {
    readonly fixtureMaterial: string;
    readonly containsPrivateKeyMaterial: boolean;
    readonly grantsLiveAuthority: boolean;
    readonly modifiesRpi5Main: boolean;
  };
}

const fixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "tests/fixtures/phase5-rpi5-signed-observation-compatibility-v1.json",
    ),
    "utf8",
  ),
) as CompatibilityFixture;
const vectors = new Map(fixture.signedVectors.map((vector) => [vector.id, vector]));

function requireVector(id: string): SignedVector {
  const vector = vectors.get(id);
  assert.ok(vector, `missing compatibility vector: ${id}`);
  return vector;
}

function bytes(vector: SignedVector): Uint8Array {
  return new TextEncoder().encode(vector.payloadUtf8);
}

function namedCode(name: string, code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    error.name === name &&
    (error as Error & { readonly code?: unknown }).code === code;
}

async function authenticate(vector: SignedVector) {
  return authenticateRpi5ObservationTransport({
    metadata: vector.metadata,
    payload: bytes(vector),
    verificationKeyRegistry: fixture.keyRegistry,
    now: fixture.referenceNow,
  });
}

async function normalize(vector: SignedVector): Promise<ProductionVisibilityReadModel> {
  await authenticate(vector);
  return normalizeSanitizedProductionVisibility(
    parseSignedRpi5ObservationPayload(bytes(vector)),
    fixture.referenceNow,
  );
}

interface PreparedCall {
  readonly query: string;
  values: readonly unknown[];
}

function result(changes: number): D1RunResultLike {
  return { success: true, meta: { changes }, results: [] };
}

/**
 * Exact in-memory model of the two D1 predicates that are protocol-visible to a
 * producer: replay identity remains active until expiry, and projection observedAt
 * advances only when the incoming value is strictly newer.
 */
class CompatibilityAcceptanceDatabase implements Rpi5ObservationAtomicD1DatabaseLike {
  readonly prepared: PreparedCall[] = [];
  private readonly statementCalls = new WeakMap<object, PreparedCall>();
  private readonly replayExpiresAtByKey = new Map<string, number>();
  private readonly observedAtByProject = new Map<string, number>();

  prepare(query: string): D1PreparedStatementLike {
    const call: PreparedCall = { query, values: [] };
    this.prepared.push(call);

    const statement: D1PreparedStatementLike = {
      bind: (...values: readonly unknown[]): D1PreparedStatementLike => {
        call.values = values;
        return statement;
      },
      run: async <Row = Record<string, unknown>>(): Promise<D1RunResultLike<Row>> => {
        const replayKey = String(call.values[0]);
        const replayExpiresAt = Number(call.values[1]);
        const claimedAt = Number(call.values[2]);
        const currentExpiry = this.replayExpiresAtByKey.get(replayKey);
        if (currentExpiry !== undefined && currentExpiry > claimedAt) {
          return result(0) as D1RunResultLike<Row>;
        }
        this.replayExpiresAtByKey.set(replayKey, replayExpiresAt);
        return result(1) as D1RunResultLike<Row>;
      },
    };
    this.statementCalls.set(statement as object, call);
    return statement;
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<D1RunResultLike[]> {
    assert.equal(statements.length, 2);
    const claim = this.statementCalls.get(statements[0] as object);
    const projection = this.statementCalls.get(statements[1] as object);
    assert.ok(claim);
    assert.ok(projection);

    const replayKey = String(claim.values[0]);
    const replayExpiresAt = Number(claim.values[1]);
    const claimedAt = Number(claim.values[2]);
    const currentExpiry = this.replayExpiresAtByKey.get(replayKey);

    if (currentExpiry !== undefined && currentExpiry > claimedAt) {
      return [result(0), result(0)];
    }
    this.replayExpiresAtByKey.set(replayKey, replayExpiresAt);

    const projectId = String(projection.values[4]);
    const observedAtMs = Number(projection.values[14]);
    const currentObservedAt = this.observedAtByProject.get(projectId);
    if (currentObservedAt === undefined || currentObservedAt < observedAtMs) {
      this.observedAtByProject.set(projectId, observedAtMs);
      return [result(1), result(1)];
    }
    return [result(1), result(0)];
  }
}

test("compatibility contract markers and synthetic public registry stay pinned", () => {
  assert.equal(fixture.contractId, "control-phase5-rpi5-signed-observation-compatibility-v1");
  assert.equal(fixture.transportVersion, RPI5_OBSERVATION_TRANSPORT_VERSION);
  assert.equal(
    fixture.verificationKeyRegistryVersion,
    RPI5_OBSERVATION_VERIFICATION_KEY_REGISTRY_VERSION,
  );
  assert.equal(fixture.maxDeliveryAgeMs, MAX_RPI5_OBSERVATION_DELIVERY_AGE_MS);
  assert.equal(
    fixture.signingDomain,
    "rozkalns-control-center.phase5.rpi5-production-visibility.v1",
  );

  const registry = normalizeRpi5ObservationVerificationKeyRegistry(fixture.keyRegistry);
  assert.deepEqual(
    registry.keys.map((entry) => entry.keyId),
    ["compat-primary-v1", "compat-secondary-v1"],
  );
  assert.equal(fixture.safety.fixtureMaterial, "SYNTHETIC_PUBLIC_NON_PRODUCTION");
  assert.equal(fixture.safety.containsPrivateKeyMaterial, false);
  assert.equal(fixture.safety.grantsLiveAuthority, false);
  assert.equal(fixture.safety.modifiesRpi5Main, false);
});

test("canonical and reordered exact-byte vectors verify and normalize identically", async () => {
  const canonical = requireVector("canonical-drifted");
  const reordered = requireVector("reordered-equivalent");
  const expected = fixture.expectations["canonical-drifted"]?.visibility;
  assert.ok(expected);

  const canonicalTransport = await authenticate(canonical);
  assert.equal(
    canonicalTransport.replayKey,
    fixture.expectations["canonical-drifted"]?.replayKey,
  );
  assert.equal(
    canonicalTransport.replayExpiresAt,
    fixture.expectations["canonical-drifted"]?.replayExpiresAt,
  );
  assert.deepEqual(await normalize(canonical), expected);
  assert.deepEqual(await normalize(reordered), expected);
});

test("exact raw payload bytes remain signature-bound before JSON normalization", async () => {
  const canonical = requireVector("canonical-drifted");
  const reordered = requireVector("reordered-equivalent");

  await assert.rejects(
    authenticateRpi5ObservationTransport({
      metadata: canonical.metadata,
      payload: bytes(reordered),
      verificationKeyRegistry: fixture.keyRegistry,
      now: fixture.referenceNow,
    }),
    namedCode("Rpi5ObservationTransportError", "INVALID_SIGNATURE"),
  );

  assert.deepEqual(await normalize(reordered), await normalize(canonical));
});

test("strict transport vectors reject malformed, stale, future and wrong-key deliveries", async () => {
  const canonical = requireVector("canonical-drifted");

  await assert.rejects(
    authenticateRpi5ObservationTransport({
      metadata: { ...canonical.metadata, deliveryId: "not-a-delivery-id" },
      payload: bytes(canonical),
      verificationKeyRegistry: fixture.keyRegistry,
      now: fixture.referenceNow,
    }),
    namedCode("Rpi5ObservationTransportError", "INVALID_INPUT"),
  );

  await assert.rejects(
    authenticateRpi5ObservationTransport({
      metadata: { ...canonical.metadata, host: "forbidden" },
      payload: bytes(canonical),
      verificationKeyRegistry: fixture.keyRegistry,
      now: fixture.referenceNow,
    }),
    namedCode("Rpi5ObservationTransportError", "UNEXPECTED_FIELD"),
  );

  for (const id of ["stale-delivery", "future-delivery"]) {
    await assert.rejects(
      authenticate(requireVector(id)),
      namedCode("Rpi5ObservationTransportError", "STALE_DELIVERY"),
    );
  }

  await assert.rejects(
    authenticate(requireVector("wrong-key-selection")),
    namedCode("Rpi5ObservationTransportError", "INVALID_SIGNATURE"),
  );
});

test("signed payload vectors fail closed on JSON, project, SHA, state and canonical timestamp errors", async () => {
  const malformedJson = requireVector("malformed-json");
  await authenticate(malformedJson);
  assert.throws(
    () => parseSignedRpi5ObservationPayload(bytes(malformedJson)),
    namedCode("Rpi5ObservationIngestionError", "INVALID_PAYLOAD"),
  );

  const cases = [
    ["wrong-project", "IDENTITY_MISMATCH"],
    ["malformed-sha", "INVALID_INPUT"],
    ["contradictory-state", "CONTRADICTORY_EVIDENCE"],
    ["noncanonical-observed-at", "INVALID_INPUT"],
  ] as const;

  for (const [id, code] of cases) {
    const vector = requireVector(id);
    await authenticate(vector);
    const parsed = parseSignedRpi5ObservationPayload(bytes(vector));
    assert.throws(
      () => normalizeSanitizedProductionVisibility(parsed, fixture.referenceNow),
      namedCode("ProductionVisibilityError", code),
    );
  }
});

test("full-ingestion freshness ceiling is explicitly fail-closed at replay expiry", async () => {
  const vector = requireVector("freshness-ceiling");
  const transport = await authenticate(vector);
  assert.equal(transport.replayExpiresAt, fixture.referenceNow);

  const database = new CompatibilityAcceptanceDatabase();
  await assert.rejects(
    acceptAuthenticatedRpi5Observation({
      metadata: vector.metadata,
      payload: bytes(vector),
      verificationKeyRegistry: fixture.keyRegistry,
      database,
      now: fixture.referenceNow,
    }),
    namedCode("Rpi5ObservationAcceptanceError", "INVALID_INPUT"),
  );
  assert.equal(database.prepared.length, 0);
});

test("acceptance vectors pin active replay and strict observedAt monotonicity", async () => {
  for (const scenario of fixture.acceptanceScenarios) {
    const database = new CompatibilityAcceptanceDatabase();

    for (let index = 0; index < scenario.vectorIds.length; index += 1) {
      const vector = requireVector(scenario.vectorIds[index] ?? "");
      const expected = scenario.expected[index];
      assert.ok(expected);

      const input = {
        metadata: vector.metadata,
        payload: bytes(vector),
        verificationKeyRegistry: fixture.keyRegistry,
        database,
        now: fixture.referenceNow,
      };

      if (expected === "ACTIVE_REPLAY") {
        await assert.rejects(
          acceptAuthenticatedRpi5Observation(input),
          namedCode("Rpi5ObservationAcceptanceError", "ACTIVE_REPLAY"),
        );
      } else {
        assert.equal(await acceptAuthenticatedRpi5Observation(input), expected);
      }
    }
  }
});
