import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import {
  CloudflareAccessJwtError,
  CloudflareAccessJwtVerifier,
  type CloudflareAccessSigningKeyResolver,
} from "../src/integrations/cloudflare/access-jwt-verifier.js";

const ISSUER = "https://rozkalns.cloudflareaccess.com";
const AUDIENCE = "d".repeat(64);
const NOW_SECONDS = 1_786_810_000;
const NOW = new Date(NOW_SECONDS * 1000);
const KID = "service-token-test-key";
const SERVICE_COMMON_NAME = "e367826f93b8d71185e03fe518aff3b4.access";

const primary = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
const secondary = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });

function publicJwk(key: KeyObject): JsonWebKey {
  return key.export({ format: "jwk" }) as JsonWebKey;
}

const primaryJwk = { ...publicJwk(primary.publicKey), alg: "RS256", use: "sig", key_ops: ["verify"] };

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function identityClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "app",
    iss: ISSUER,
    aud: [AUDIENCE],
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS - 60,
    nbf: NOW_SECONDS - 60,
    sub: "user-123",
    email: "andris@example.test",
    ...overrides,
  };
}

function serviceClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "app",
    iss: ISSUER,
    aud: [AUDIENCE],
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS - 60,
    common_name: SERVICE_COMMON_NAME,
    sub: "",
    ...overrides,
  };
}

function makeToken(options: {
  readonly claims?: Record<string, unknown>;
  readonly signingKey?: KeyObject;
} = {}): string {
  const encodedHeader = encodeJson({ alg: "RS256", kid: KID });
  const encodedPayload = encodeJson(options.claims ?? serviceClaims());
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), options.signingKey ?? primary.privateKey).toString("base64url");
  return `${input}.${signature}`;
}

class StaticResolver implements CloudflareAccessSigningKeyResolver {
  async resolveSigningKey(kid: string): Promise<JsonWebKey> {
    if (kid !== KID) throw new Error("not found");
    return primaryJwk;
  }
}

function verifier() {
  return new CloudflareAccessJwtVerifier({ issuer: ISSUER, audience: AUDIENCE }, new StaticResolver());
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CloudflareAccessJwtError);
    assert.equal(error.code, code);
    return true;
  });
}

test("accepts the documented Access service-token application JWT shape without nbf", async () => {
  const token = makeToken();
  const principal = await verifier().verifyToken(token, NOW);

  assert.deepEqual(principal, {
    subject: `service-token:${SERVICE_COMMON_NAME}`,
    email: null,
  });
  const serialized = JSON.stringify(principal);
  assert.equal(serialized.includes(token), false);
  assert.equal("common_name" in principal, false);
  assert.equal("signature" in principal, false);
});

test("validates service-token nbf when present instead of requiring it", async () => {
  assert.deepEqual(
    await verifier().verifyToken(makeToken({ claims: serviceClaims({ nbf: NOW_SECONDS - 30 }) }), NOW),
    { subject: `service-token:${SERVICE_COMMON_NAME}`, email: null },
  );

  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: serviceClaims({ nbf: NOW_SECONDS + 1 }) }), NOW),
    "ACCESS_JWT_NOT_YET_VALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: serviceClaims({ nbf: "later" }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
});

test("rejects malformed and mixed service-token identity claim forms fail closed", async () => {
  const withoutCommonName = serviceClaims();
  delete withoutCommonName.common_name;
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: withoutCommonName }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );

  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: serviceClaims({ common_name: "" }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: serviceClaims({ common_name: "x".repeat(307) }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: serviceClaims({ email: "person@example.test" }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: serviceClaims({ identity_nonce: "identity-cache-key" }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: identityClaims({ common_name: SERVICE_COMMON_NAME }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
});

test("keeps exact signature, issuer and audience validation for service-token JWTs", async () => {
  await rejectsCode(
    verifier().verifyToken(makeToken({ signingKey: secondary.privateKey }), NOW),
    "ACCESS_JWT_SIGNATURE_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(
      makeToken({ claims: serviceClaims({ iss: "https://other.cloudflareaccess.com" }) }),
      NOW,
    ),
    "ACCESS_JWT_ISSUER_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: serviceClaims({ aud: ["wrong-audience"] }) }), NOW),
    "ACCESS_JWT_AUDIENCE_INVALID",
  );
});

test("keeps the interactive identity path strict and requires its nbf", async () => {
  assert.deepEqual(
    await verifier().verifyToken(makeToken({ claims: identityClaims() }), NOW),
    { subject: "user-123", email: "andris@example.test" },
  );

  const withoutNbf = identityClaims();
  delete withoutNbf.nbf;
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: withoutNbf }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
});

test("keeps service-token temporal claims coherent and bounded", async () => {
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: serviceClaims({ exp: NOW_SECONDS }) }), NOW),
    "ACCESS_JWT_EXPIRED",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: serviceClaims({ iat: NOW_SECONDS + 1 }) }), NOW),
    "ACCESS_JWT_ISSUED_IN_FUTURE",
  );
  await rejectsCode(
    verifier().verifyToken(
      makeToken({ claims: serviceClaims({ exp: NOW_SECONDS + 30, nbf: NOW_SECONDS + 30 }) }),
      NOW,
    ),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
});
