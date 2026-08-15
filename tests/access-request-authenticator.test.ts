import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import type { CloudflareAccessJwksFetch } from "../src/integrations/cloudflare/access-jwks-resolver.js";
import {
  CloudflareAccessAuthenticationError,
  CloudflareAccessRequestAuthenticator,
} from "../src/worker/access-request-authenticator.js";

const ISSUER = "https://rozkalns.cloudflareaccess.com";
const AUDIENCE = "c".repeat(64);
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const NOW_SECONDS = 1_786_810_000;
const NOW = new Date(NOW_SECONDS * 1000);

const current = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
const previous = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
const rotated = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });

const CURRENT_KID = "access-current";
const PREVIOUS_KID = "access-previous";
const ROTATED_KID = "access-rotated";

function signingJwk(kid: string, key: KeyObject): JsonWebKey {
  const jwk = key.export({ format: "jwk" }) as JsonWebKey;
  return { ...jwk, kid, alg: "RS256", use: "sig", key_ops: ["verify"] };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
  readonly kid?: string;
  readonly signingKey?: KeyObject;
  readonly claims?: Record<string, unknown>;
} = {}): string {
  const encodedHeader = encodeJson({ alg: "RS256", kid: options.kid ?? CURRENT_KID });
  const encodedPayload = encodeJson(options.claims ?? claims());
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), options.signingKey ?? current.privateKey).toString("base64url");
  return `${input}.${signature}`;
}

function requestWithToken(token: string): Request {
  return new Request("https://control.rozkalns.net/api/future-action", {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
}

function jwksResponse(keys: readonly JsonWebKey[]): Response {
  const body = JSON.stringify({ keys });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
  });
}

function sequenceFetch(
  responders: Array<() => Promise<Response> | Response>,
  seen: Array<{ input: string; init: RequestInit }>,
): CloudflareAccessJwksFetch {
  return async (input, init) => {
    seen.push({ input, init });
    const responder = responders.shift();
    if (!responder) throw new Error("unexpected fetch");
    return responder();
  };
}

function authenticator(fetch: CloudflareAccessJwksFetch): CloudflareAccessRequestAuthenticator {
  return new CloudflareAccessRequestAuthenticator(
    {
      issuer: ISSUER,
      audience: AUDIENCE,
      cacheTtlMs: 60_000,
      timeoutMs: 1_000,
    },
    { fetch, clock: () => NOW },
  );
}

async function rejectsAuthentication(promise: Promise<unknown>, secretNeedle?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CloudflareAccessAuthenticationError);
    assert.equal(error.code, "ACCESS_AUTHENTICATION_FAILED");
    assert.equal(error.message, "ACCESS_AUTHENTICATION_FAILED");
    if (secretNeedle) assert.equal(error.message.includes(secretNeedle), false);
    return true;
  });
}

test("composes fixed team-domain JWKS resolution with exact JWT verification", async () => {
  const seen: Array<{ input: string; init: RequestInit }> = [];
  const auth = authenticator(
    sequenceFetch([() => jwksResponse([signingJwk(CURRENT_KID, current.publicKey)])], seen),
  );

  const token = makeToken();
  const principal = await auth.authenticateRequest(requestWithToken(token));

  assert.deepEqual(principal, { subject: "user-123", email: "andris@example.test" });
  assert.equal(JSON.stringify(principal).includes(token), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.input, CERTS_URL);
  assert.equal(seen[0]?.init.method, "GET");
  assert.equal(seen[0]?.init.redirect, "error");
});

test("accepts current and previous Access signing keys from one cached JWKS set", async () => {
  const seen: Array<{ input: string; init: RequestInit }> = [];
  const auth = authenticator(
    sequenceFetch(
      [() => jwksResponse([
        signingJwk(CURRENT_KID, current.publicKey),
        signingJwk(PREVIOUS_KID, previous.publicKey),
      ])],
      seen,
    ),
  );

  assert.equal((await auth.authenticateRequest(requestWithToken(makeToken()))).subject, "user-123");
  assert.equal(
    (await auth.authenticateRequest(requestWithToken(makeToken({ kid: PREVIOUS_KID, signingKey: previous.privateKey })))).subject,
    "user-123",
  );
  assert.equal(seen.length, 1);
});

test("refreshes once on a fresh-cache kid miss and accepts a newly rotated key", async () => {
  const seen: Array<{ input: string; init: RequestInit }> = [];
  const auth = authenticator(
    sequenceFetch(
      [
        () => jwksResponse([signingJwk(CURRENT_KID, current.publicKey)]),
        () => jwksResponse([
          signingJwk(ROTATED_KID, rotated.publicKey),
          signingJwk(CURRENT_KID, current.publicKey),
        ]),
      ],
      seen,
    ),
  );

  await auth.authenticateRequest(requestWithToken(makeToken()));
  const principal = await auth.authenticateRequest(
    requestWithToken(makeToken({ kid: ROTATED_KID, signingKey: rotated.privateKey })),
  );

  assert.equal(principal.subject, "user-123");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((entry) => entry.input), [CERTS_URL, CERTS_URL]);
});

test("collapses missing header, cookie-only and forged signatures to one outer auth failure", async () => {
  const seen: Array<{ input: string; init: RequestInit }> = [];
  const auth = authenticator(
    sequenceFetch([() => jwksResponse([signingJwk(CURRENT_KID, current.publicKey)])], seen),
  );

  await rejectsAuthentication(auth.authenticateRequest(new Request("https://control.rozkalns.net/api/future-action")));
  assert.equal(seen.length, 0);

  await rejectsAuthentication(
    auth.authenticateRequest(new Request("https://control.rozkalns.net/api/future-action", {
      headers: { Cookie: `CF_Authorization=${makeToken()}` },
    })),
  );
  assert.equal(seen.length, 0);

  const forged = makeToken({ signingKey: attacker.privateKey });
  await rejectsAuthentication(auth.authenticateRequest(requestWithToken(forged)), forged);
  assert.equal(seen.length, 1);
});

test("collapses wrong issuer and audience claims after valid signature verification", async () => {
  const issuerSeen: Array<{ input: string; init: RequestInit }> = [];
  const issuerAuth = authenticator(
    sequenceFetch([() => jwksResponse([signingJwk(CURRENT_KID, current.publicKey)])], issuerSeen),
  );
  await rejectsAuthentication(
    issuerAuth.authenticateRequest(requestWithToken(makeToken({ claims: claims({ iss: "https://other.cloudflareaccess.com" }) }))),
  );

  const audienceSeen: Array<{ input: string; init: RequestInit }> = [];
  const audienceAuth = authenticator(
    sequenceFetch([() => jwksResponse([signingJwk(CURRENT_KID, current.publicKey)])], audienceSeen),
  );
  await rejectsAuthentication(
    audienceAuth.authenticateRequest(requestWithToken(makeToken({ claims: claims({ aud: ["wrong-audience"] }) }))),
  );

  assert.equal(issuerSeen[0]?.input, CERTS_URL);
  assert.equal(audienceSeen[0]?.input, CERTS_URL);
});

test("collapses JWKS network and unknown-key failures without exposing key details", async () => {
  const networkSeen: Array<{ input: string; init: RequestInit }> = [];
  const networkAuth = authenticator(
    sequenceFetch([async () => { throw new Error("network secret detail"); }], networkSeen),
  );
  await rejectsAuthentication(networkAuth.authenticateRequest(requestWithToken(makeToken())), "network secret detail");
  assert.equal(networkSeen[0]?.input, CERTS_URL);

  const unknownSeen: Array<{ input: string; init: RequestInit }> = [];
  const unknownAuth = authenticator(
    sequenceFetch([() => jwksResponse([signingJwk(CURRENT_KID, current.publicKey)])], unknownSeen),
  );
  const unknownToken = makeToken({ kid: ROTATED_KID, signingKey: rotated.privateKey });
  await rejectsAuthentication(unknownAuth.authenticateRequest(requestWithToken(unknownToken)), ROTATED_KID);
  assert.equal(unknownSeen.length, 1);
});
