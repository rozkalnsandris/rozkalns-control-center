import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import {
  CloudflareAccessJwtError,
  CloudflareAccessJwtVerifier,
  type CloudflareAccessSigningKeyResolver,
} from "../src/integrations/cloudflare/access-jwt-verifier.js";

const ISSUER = "https://rozkalns.cloudflareaccess.com";
const AUDIENCE = "c".repeat(64);
const NOW_SECONDS = 1_786_810_000;
const NOW = new Date(NOW_SECONDS * 1000);
const PRIMARY_KID = "access-key-primary";
const SECONDARY_KID = "access-key-secondary";

const primary = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
const secondary = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });

function publicJwk(key: KeyObject): JsonWebKey {
  return key.export({ format: "jwk" }) as JsonWebKey;
}

const primaryJwk = { ...publicJwk(primary.publicKey), alg: "RS256", use: "sig", key_ops: ["verify"] };
const secondaryJwk = { ...publicJwk(secondary.publicKey), alg: "RS256", use: "sig", key_ops: ["verify"] };

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function makeToken(options: {
  readonly header?: Record<string, unknown>;
  readonly claims?: Record<string, unknown>;
  readonly signingKey?: KeyObject;
} = {}): string {
  const encodedHeader = encodeJson(options.header ?? { alg: "RS256", kid: PRIMARY_KID });
  const encodedPayload = encodeJson(options.claims ?? baseClaims());
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), options.signingKey ?? primary.privateKey).toString("base64url");
  return `${input}.${signature}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class StaticResolver implements CloudflareAccessSigningKeyResolver {
  readonly seenKids: string[] = [];
  readonly #keys: ReadonlyMap<string, JsonWebKey>;

  constructor(keys: ReadonlyMap<string, JsonWebKey> = new Map([[PRIMARY_KID, primaryJwk]])) {
    this.#keys = keys;
  }

  async resolveSigningKey(kid: string): Promise<JsonWebKey> {
    this.seenKids.push(kid);
    const key = this.#keys.get(kid);
    if (!key) throw new Error("not found");
    return key;
  }
}

function verifier(resolver: CloudflareAccessSigningKeyResolver = new StaticResolver()) {
  return new CloudflareAccessJwtVerifier({ issuer: ISSUER, audience: AUDIENCE }, resolver);
}

async function captureJwtError(
  promise: Promise<unknown>,
  code: string,
): Promise<CloudflareAccessJwtError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof CloudflareAccessJwtError);
  assert.equal(caught.code, code);
  return caught;
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await captureJwtError(promise, code);
}

test("verifies an exact RS256 Access application JWT and returns bounded principal evidence", async () => {
  const resolver = new StaticResolver();
  const token = makeToken();
  const principal = await verifier(resolver).verifyToken(token, NOW);

  assert.deepEqual(principal, { subject: "user-123", email: "andris@example.test" });
  assert.deepEqual(resolver.seenKids, [PRIMARY_KID]);
  assert.equal(JSON.stringify(principal).includes(token), false);
  assert.equal("signature" in principal, false);
});

test("request verification trusts only Cf-Access-Jwt-Assertion and never a cookie fallback", async () => {
  const token = makeToken();
  const request = new Request("https://control.example.test/action", {
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      Cookie: `CF_Authorization=${makeToken({ signingKey: secondary.privateKey })}`,
    },
  });
  assert.equal((await verifier().verifyRequest(request, NOW)).subject, "user-123");

  const cookieOnly = new Request("https://control.example.test/action", {
    headers: { Cookie: `CF_Authorization=${token}` },
  });
  await rejectsCode(verifier().verifyRequest(cookieOnly, NOW), "ACCESS_JWT_MISSING");
});

test("rejects forged signatures and proves claims are not trusted before signature verification", async () => {
  const forged = await captureJwtError(
    verifier().verifyToken(makeToken({ signingKey: secondary.privateKey }), NOW),
    "ACCESS_JWT_SIGNATURE_INVALID",
  );
  assert.equal(forged.audienceDiagnostic, null);

  const forgedAudience = await captureJwtError(
    verifier().verifyToken(
      makeToken({
        claims: baseClaims({ aud: ["forged-audience"] }),
        signingKey: secondary.privateKey,
      }),
      NOW,
    ),
    "ACCESS_JWT_SIGNATURE_INVALID",
  );
  assert.equal(forgedAudience.audienceDiagnostic, null);

  await rejectsCode(
    verifier().verifyToken(
      makeToken({
        claims: baseClaims({ iss: "https://attacker.cloudflareaccess.com" }),
        signingKey: secondary.privateKey,
      }),
      NOW,
    ),
    "ACCESS_JWT_SIGNATURE_INVALID",
  );
});

test("fails closed for unknown kid and invalid RSA signing-key evidence", async () => {
  const unknownKid = makeToken({ header: { alg: "RS256", kid: "missing-key" } });
  await rejectsCode(verifier().verifyToken(unknownKid, NOW), "ACCESS_JWT_KEY_UNAVAILABLE");

  const invalidResolver = new StaticResolver(
    new Map([[PRIMARY_KID, { kty: "EC", crv: "P-256", x: "x", y: "y", alg: "RS256", use: "sig" }]]),
  );
  await rejectsCode(verifier(invalidResolver).verifyToken(makeToken(), NOW), "ACCESS_JWT_KEY_INVALID");
});

test("requires RS256 and a bounded non-empty kid before key resolution", async () => {
  const resolver = new StaticResolver();
  await rejectsCode(
    verifier(resolver).verifyToken(makeToken({ header: { alg: "HS256", kid: PRIMARY_KID } }), NOW),
    "ACCESS_JWT_HEADER_INVALID",
  );
  await rejectsCode(
    verifier(resolver).verifyToken(makeToken({ header: { alg: "RS256", kid: "" } }), NOW),
    "ACCESS_JWT_HEADER_INVALID",
  );
  assert.deepEqual(resolver.seenKids, []);
});

test("binds application type, issuer and audience exactly", async () => {
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ type: "org" }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ iss: "https://other.cloudflareaccess.com" }) }), NOW),
    "ACCESS_JWT_ISSUER_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ aud: ["other-audience"] }) }), NOW),
    "ACCESS_JWT_AUDIENCE_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ aud: AUDIENCE }) }), NOW),
    "ACCESS_JWT_AUDIENCE_INVALID",
  );
});

test("audience mismatch exposes only bounded signed shape and fingerprints", async () => {
  const wrongAudience = "other-audience";
  const arrayError = await captureJwtError(
    verifier().verifyToken(makeToken({ claims: baseClaims({ aud: [wrongAudience] }) }), NOW),
    "ACCESS_JWT_AUDIENCE_INVALID",
  );
  assert.deepEqual(arrayError.audienceDiagnostic, {
    shape: "ARRAY",
    count: 1,
    sha256: [sha256(wrongAudience)],
  });
  assert.equal(JSON.stringify(arrayError.audienceDiagnostic).includes(wrongAudience), false);

  const stringError = await captureJwtError(
    verifier().verifyToken(makeToken({ claims: baseClaims({ aud: AUDIENCE }) }), NOW),
    "ACCESS_JWT_AUDIENCE_INVALID",
  );
  assert.deepEqual(stringError.audienceDiagnostic, {
    shape: "STRING",
    count: 1,
    sha256: [sha256(AUDIENCE)],
  });
  assert.equal(JSON.stringify(stringError.audienceDiagnostic).includes(AUDIENCE), false);

  const otherError = await captureJwtError(
    verifier().verifyToken(makeToken({ claims: baseClaims({ aud: 42 }) }), NOW),
    "ACCESS_JWT_AUDIENCE_INVALID",
  );
  assert.deepEqual(otherError.audienceDiagnostic, {
    shape: "OTHER",
    count: 0,
    sha256: [],
  });
});

test("audience diagnostics bound count and fingerprint cardinality", async () => {
  const audiences = Array.from({ length: 40 }, (_, index) => `audience-${index}`);
  const error = await captureJwtError(
    verifier().verifyToken(makeToken({ claims: baseClaims({ aud: audiences }) }), NOW),
    "ACCESS_JWT_AUDIENCE_INVALID",
  );
  assert.equal(error.audienceDiagnostic?.shape, "ARRAY");
  assert.equal(error.audienceDiagnostic?.count, 32);
  assert.deepEqual(
    error.audienceDiagnostic?.sha256,
    audiences.slice(0, 4).map(sha256),
  );
});

test("fails closed on expired, not-yet-valid and future-issued tokens", async () => {
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ exp: NOW_SECONDS }) }), NOW),
    "ACCESS_JWT_EXPIRED",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ nbf: NOW_SECONDS + 1 }) }), NOW),
    "ACCESS_JWT_NOT_YET_VALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ iat: NOW_SECONDS + 1 }) }), NOW),
    "ACCESS_JWT_ISSUED_IN_FUTURE",
  );
});

test("requires coherent integer temporal claims and a human principal subject", async () => {
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ exp: "later" }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ exp: NOW_SECONDS - 10, iat: NOW_SECONDS - 5 }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ sub: "" }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
});

test("accepts absent email but rejects malformed asserted email", async () => {
  const withoutEmail = baseClaims();
  delete withoutEmail.email;
  assert.deepEqual(
    await verifier().verifyToken(makeToken({ claims: withoutEmail }), NOW),
    { subject: "user-123", email: null },
  );

  await rejectsCode(
    verifier().verifyToken(makeToken({ claims: baseClaims({ email: "not-an-email" }) }), NOW),
    "ACCESS_JWT_CLAIMS_INVALID",
  );
});

test("rejects malformed compact JWT and unsafe verifier configuration", async () => {
  await rejectsCode(verifier().verifyToken("not-a-jwt", NOW), "ACCESS_JWT_MALFORMED");
  await rejectsCode(verifier().verifyToken("a.b.c", NOW), "ACCESS_JWT_HEADER_INVALID");

  assert.throws(
    () => new CloudflareAccessJwtVerifier({ issuer: "http://rozkalns.cloudflareaccess.com", audience: AUDIENCE }, new StaticResolver()),
    (error: unknown) => error instanceof CloudflareAccessJwtError && error.code === "ACCESS_JWT_ISSUER_INVALID",
  );
  assert.throws(
    () => new CloudflareAccessJwtVerifier({ issuer: ISSUER, audience: "bad audience" }, new StaticResolver()),
    (error: unknown) => error instanceof CloudflareAccessJwtError && error.code === "ACCESS_JWT_AUDIENCE_INVALID",
  );
});

test("resolver is selected only by validated kid and cannot receive an arbitrary URL", async () => {
  const resolver = new StaticResolver(new Map([
    [PRIMARY_KID, primaryJwk],
    [SECONDARY_KID, secondaryJwk],
  ]));
  const token = makeToken({ header: { alg: "RS256", kid: SECONDARY_KID }, signingKey: secondary.privateKey });
  await verifier(resolver).verifyToken(token, NOW);
  assert.deepEqual(resolver.seenKids, [SECONDARY_KID]);
  assert.equal(resolver.seenKids[0]?.includes("https://"), false);
});
