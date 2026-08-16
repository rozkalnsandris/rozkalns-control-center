import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudflareAccessJwksError,
  CloudflareAccessJwksResolver,
  type CloudflareAccessJwksErrorCode,
  type CloudflareAccessJwksFetch,
} from "../src/integrations/cloudflare/access-jwks-resolver.js";

const ISSUER = "https://rozkalns.cloudflareaccess.com";
const ENDPOINT = `${ISSUER}/cdn-cgi/access/certs`;

function jwk(kid: string, marker = "A") {
  return {
    kid,
    kty: "RSA",
    alg: "RS256",
    use: "sig",
    e: "AQAB",
    n: marker.repeat(342),
  };
}

function jwksResponse(keys: unknown[], init?: ResponseInit): Response {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function rejectsCode(promise: Promise<unknown>, code: CloudflareAccessJwksErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof CloudflareAccessJwksError && error.code === code);
}

test("derives one fixed Access certs endpoint and performs a bounded manual-redirect GET", async () => {
  let seenInput = "";
  let seenInit: RequestInit | undefined;

  const fetch: CloudflareAccessJwksFetch = async (input, init) => {
    seenInput = input;
    seenInit = init;
    return jwksResponse([jwk("kid-current")]);
  };

  const resolver = new CloudflareAccessJwksResolver({ issuer: ISSUER, fetch });
  const key = await resolver.resolveSigningKey("kid-current");

  assert.equal(resolver.endpoint, ENDPOINT);
  assert.equal(seenInput, ENDPOINT);
  assert.equal(seenInit?.method, "GET");
  assert.equal(seenInit?.redirect, "manual");
  assert.equal(new Headers(seenInit?.headers).get("accept"), "application/json");
  assert.ok(seenInit?.signal instanceof AbortSignal);
  assert.equal(key.alg, "RS256");
  assert.equal(key.use, "sig");
});

test("serves a fresh cache hit without another network request", async () => {
  let fetchCount = 0;
  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => {
      fetchCount += 1;
      return jwksResponse([jwk("kid-current")]);
    },
  });

  const first = await resolver.resolveSigningKey("kid-current");
  const second = await resolver.resolveSigningKey("kid-current");

  assert.equal(fetchCount, 1);
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
});

test("returns both current and previous rotation keys from one JWKS fetch", async () => {
  let fetchCount = 0;
  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => {
      fetchCount += 1;
      return jwksResponse([jwk("kid-current", "A"), jwk("kid-previous", "B")]);
    },
  });

  const current = await resolver.resolveSigningKey("kid-current");
  const previous = await resolver.resolveSigningKey("kid-previous");

  assert.equal(fetchCount, 1);
  assert.equal(current.n, "A".repeat(342));
  assert.equal(previous.n, "B".repeat(342));
});

test("refreshes a stale cache after the bounded TTL", async () => {
  let now = 0;
  let fetchCount = 0;
  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    cacheTtlMs: 1_000,
    now: () => now,
    fetch: async () => {
      fetchCount += 1;
      return jwksResponse([jwk("kid-current", fetchCount === 1 ? "A" : "B")]);
    },
  });

  const first = await resolver.resolveSigningKey("kid-current");
  now = 1_001;
  const second = await resolver.resolveSigningKey("kid-current");

  assert.equal(fetchCount, 2);
  assert.equal(first.n, "A".repeat(342));
  assert.equal(second.n, "B".repeat(342));
});

test("refreshes once immediately when a fresh cache misses the requested kid", async () => {
  let fetchCount = 0;
  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? jwksResponse([jwk("kid-old")])
        : jwksResponse([jwk("kid-new"), jwk("kid-old")]);
    },
  });

  await resolver.resolveSigningKey("kid-old");
  const rotated = await resolver.resolveSigningKey("kid-new");

  assert.equal(fetchCount, 2);
  assert.equal(rotated.n, "A".repeat(342));
});

test("an unknown kid fails after exactly one immediate refresh", async () => {
  let fetchCount = 0;
  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => {
      fetchCount += 1;
      return jwksResponse([jwk("kid-known")]);
    },
  });

  await resolver.resolveSigningKey("kid-known");
  await rejectsCode(resolver.resolveSigningKey("kid-missing"), "ACCESS_JWKS_KEY_NOT_FOUND");
  assert.equal(fetchCount, 2);
});

test("coalesces concurrent refreshes into one network request", async () => {
  let fetchCount = 0;
  let release: ((response: Response) => void) | undefined;
  const pendingResponse = new Promise<Response>((resolve) => {
    release = resolve;
  });

  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => {
      fetchCount += 1;
      return pendingResponse;
    },
  });

  const first = resolver.resolveSigningKey("kid-current");
  const second = resolver.resolveSigningKey("kid-current");
  const third = resolver.resolveSigningKey("kid-previous");

  await Promise.resolve();
  assert.equal(fetchCount, 1);
  assert.ok(release);
  release(jwksResponse([jwk("kid-current"), jwk("kid-previous", "B")]));

  const [currentA, currentB, previous] = await Promise.all([first, second, third]);
  assert.equal(currentA.n, currentB.n);
  assert.equal(previous.n, "B".repeat(342));
  assert.equal(fetchCount, 1);
});

test("a failed refresh does not poison a prior fresh good cache", async () => {
  let fetchCount = 0;
  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => {
      fetchCount += 1;
      if (fetchCount === 1) return jwksResponse([jwk("kid-known")]);
      return jwksResponse([jwk("duplicate"), jwk("duplicate")]);
    },
  });

  const known = await resolver.resolveSigningKey("kid-known");
  await rejectsCode(resolver.resolveSigningKey("kid-rotated"), "ACCESS_JWKS_SET_INVALID");
  const knownAgain = await resolver.resolveSigningKey("kid-known");

  assert.equal(fetchCount, 2);
  assert.deepEqual(knownAgain, known);
});

test("fails closed on network failure and non-success HTTP responses", async () => {
  const networkFailure = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => {
      throw new Error("network unavailable");
    },
  });
  await rejectsCode(networkFailure.resolveSigningKey("kid-current"), "ACCESS_JWKS_FETCH_FAILED");

  const badStatus = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => new Response("unavailable", { status: 503 }),
  });
  await rejectsCode(badStatus.resolveSigningKey("kid-current"), "ACCESS_JWKS_RESPONSE_INVALID");
});

test("manual redirect responses fail closed without a second fetch", async () => {
  for (const status of [301, 302, 307, 308]) {
    let fetchCount = 0;
    let seenRedirect: RequestRedirect | undefined;

    const resolver = new CloudflareAccessJwksResolver({
      issuer: ISSUER,
      fetch: async (_input, init) => {
        fetchCount += 1;
        seenRedirect = init.redirect;
        return new Response(null, {
          status,
          headers: { Location: "https://attacker.example/keys" },
        });
      },
    });

    await rejectsCode(resolver.resolveSigningKey("kid-current"), "ACCESS_JWKS_RESPONSE_INVALID");
    assert.equal(seenRedirect, "manual");
    assert.equal(fetchCount, 1);
  }
});

test("rejects a redirect response before reading headers or Location", async () => {
  let headerReads = 0;
  const redirectResponse = {
    ok: false,
    get headers(): never {
      headerReads += 1;
      throw new Error("redirect headers must not be inspected");
    },
  } as unknown as Response;

  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => redirectResponse,
  });

  await rejectsCode(resolver.resolveSigningKey("kid-current"), "ACCESS_JWKS_RESPONSE_INVALID");
  assert.equal(headerReads, 0);
});

test("rejects oversized or malformed JWKS responses", async () => {
  const oversized = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => new Response("{}", { headers: { "content-length": "40000" } }),
  });
  await rejectsCode(oversized.resolveSigningKey("kid-current"), "ACCESS_JWKS_RESPONSE_INVALID");

  const malformedJson = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async () => new Response("not-json", { status: 200 }),
  });
  await rejectsCode(malformedJson.resolveSigningKey("kid-current"), "ACCESS_JWKS_SET_INVALID");
});

test("rejects duplicate, excessive and unsafe signing-key sets", async () => {
  const invalidSets: unknown[][] = [
    [jwk("duplicate"), jwk("duplicate")],
    [jwk("one"), jwk("two"), jwk("three"), jwk("four"), jwk("five")],
    [{ ...jwk("ec-key"), kty: "EC" }],
    [{ ...jwk("wrong-alg"), alg: "RS512" }],
    [{ ...jwk("wrong-use"), use: "enc" }],
    [{ ...jwk("unsafe-ops"), key_ops: ["verify", "sign"] }],
    [{ ...jwk("bad-modulus"), n: "not=base64url" }],
  ];

  for (const keys of invalidSets) {
    const resolver = new CloudflareAccessJwksResolver({ issuer: ISSUER, fetch: async () => jwksResponse(keys) });
    await rejectsCode(resolver.resolveSigningKey("anything"), "ACCESS_JWKS_SET_INVALID");
  }
});

test("never lets request kid data select or alter the network endpoint", async () => {
  const seen: string[] = [];
  const resolver = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    fetch: async (input) => {
      seen.push(input);
      return jwksResponse([jwk("kid-known")]);
    },
  });

  await resolver.resolveSigningKey("kid-known");
  await rejectsCode(resolver.resolveSigningKey("kid-other"), "ACCESS_JWKS_KEY_NOT_FOUND");

  assert.deepEqual(seen, [ENDPOINT, ENDPOINT]);
});

test("rejects unsafe issuer, cache, timeout and clock configuration", async () => {
  const unsafeIssuers = [
    "http://rozkalns.cloudflareaccess.com",
    "https://user@rozkalns.cloudflareaccess.com",
    "https://rozkalns.cloudflareaccess.com/path",
    "https://rozkalns.cloudflareaccess.com/?query=1",
    "https://example.com",
  ];

  for (const issuer of unsafeIssuers) {
    assert.throws(
      () => new CloudflareAccessJwksResolver({ issuer }),
      (error: unknown) => error instanceof CloudflareAccessJwksError && error.code === "ACCESS_JWKS_CONFIG_INVALID",
    );
  }

  assert.throws(
    () => new CloudflareAccessJwksResolver({ issuer: ISSUER, cacheTtlMs: 999 }),
    (error: unknown) => error instanceof CloudflareAccessJwksError && error.code === "ACCESS_JWKS_CONFIG_INVALID",
  );
  assert.throws(
    () => new CloudflareAccessJwksResolver({ issuer: ISSUER, timeoutMs: 20_000 }),
    (error: unknown) => error instanceof CloudflareAccessJwksError && error.code === "ACCESS_JWKS_CONFIG_INVALID",
  );

  const invalidClock = new CloudflareAccessJwksResolver({
    issuer: ISSUER,
    now: () => Number.NaN,
    fetch: async () => jwksResponse([jwk("kid-current")]),
  });
  await rejectsCode(invalidClock.resolveSigningKey("kid-current"), "ACCESS_JWKS_CONFIG_INVALID");
});
