import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_REST_API_VERSION,
  createGitHubReadRequest,
  parseGitHubInstallationReadScope,
  type GitHubInstallationReadScope,
} from "../src/integrations/github/app-installation-read-contract.js";
import {
  GITHUB_APP_JWT_ALGORITHM,
  GITHUB_APP_JWT_CLOCK_SKEW_SECONDS,
  GITHUB_APP_JWT_FUTURE_LIFETIME_SECONDS,
  GitHubAppSessionError,
  createGitHubAppInstallationSessionProvider,
  type GitHubAppCredentialFetch,
  type GitHubAppJwtSigner,
} from "../src/integrations/github/app-installation-session.js";
import {
  GITHUB_REST_ACCEPT,
  createGitHubRestReadTransport,
} from "../src/integrations/github/rest-read-transport.js";

const observedAt = "2026-08-11T20:30:00.000Z";

function scope(): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 123,
    repositories: ["rozkalnsandris/hermes-tech", "rozkalnsandris/RPi5_main"],
    permissions: { metadata: "read", pull_requests: "read", checks: "read" },
  });
}

function tokenPayload(overrides: Record<string, unknown> = {}) {
  return {
    token: "test-only-opaque-installation-credential",
    expires_at: "2026-08-11T21:30:00.000Z",
    permissions: { metadata: "read", pull_requests: "read", checks: "read" },
    repository_selection: "selected",
    repositories: [
      { full_name: "rozkalnsandris/hermes-tech" },
      { full_name: "rozkalnsandris/RPi5_main" },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function signer(capture?: (input: string) => void): GitHubAppJwtSigner {
  return {
    async signRs256(input) {
      capture?.(new TextDecoder().decode(input));
      return new Uint8Array([1, 2, 3, 4]);
    },
  };
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof GitHubAppSessionError ? error.code : undefined;
}

test("builds bounded RS256 JWT claims and explicitly narrows token scope", async () => {
  let signingInput = "";
  let tokenRequest: Request | undefined;
  const provider = createGitHubAppInstallationSessionProvider({
    identity: { clientId: "Iv23li-control-client" },
    signer: signer((value) => {
      signingInput = value;
    }),
    fetchRequest: async (request) => {
      tokenRequest = request;
      return jsonResponse(tokenPayload());
    },
  });

  const session = await provider(scope(), observedAt);
  assert.equal(session.credentialLease.installationId, 123);
  assert.equal(session.credentialLease.expiresAt, "2026-08-11T21:30:00.000Z");
  assert.ok(tokenRequest);
  assert.equal(tokenRequest.method, "POST");
  assert.equal(tokenRequest.url, "https://api.github.com/app/installations/123/access_tokens");
  assert.equal(tokenRequest.redirect, "manual");
  assert.equal(tokenRequest.headers.get("accept"), GITHUB_REST_ACCEPT);
  assert.equal(tokenRequest.headers.get("x-github-api-version"), GITHUB_REST_API_VERSION);
  assert.equal(tokenRequest.headers.get("content-type"), "application/json");

  const authorization = tokenRequest.headers.get("authorization");
  assert.ok(authorization);
  assert.ok(authorization.startsWith("Bearer "));
  const jwt = authorization.slice("Bearer ".length);
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  assert.equal(`${headerPart}.${payloadPart}`, signingInput);
  assert.ok(signaturePart);

  const header = decodeJwtPart<{ alg: string; typ: string }>(headerPart);
  const payload = decodeJwtPart<{ iat: number; exp: number; iss: string }>(payloadPart);
  const observedSeconds = Date.parse(observedAt) / 1000;
  assert.deepEqual(header, { alg: GITHUB_APP_JWT_ALGORITHM, typ: "JWT" });
  assert.equal(payload.iat, observedSeconds - GITHUB_APP_JWT_CLOCK_SKEW_SECONDS);
  assert.equal(payload.exp, observedSeconds + GITHUB_APP_JWT_FUTURE_LIFETIME_SECONDS);
  assert.equal(payload.iss, "Iv23li-control-client");

  const body = JSON.parse(await tokenRequest.text()) as {
    repositories: string[];
    permissions: Record<string, string>;
  };
  assert.deepEqual(body.repositories, ["hermes-tech", "RPi5_main"]);
  assert.deepEqual(body.permissions, { metadata: "read", pull_requests: "read", checks: "read" });
});

test("keeps installation credential opaque across format and length changes", async () => {
  for (const rawCredential of ["x", "future-format_without-a-known-prefix_1234567890"]) {
    const provider = createGitHubAppInstallationSessionProvider({
      identity: { clientId: "control-client" },
      signer: signer(),
      fetchRequest: async () => jsonResponse(tokenPayload({ token: rawCredential })),
    });
    const session = await provider(scope(), observedAt);
    assert.equal(JSON.stringify(session.credentialLease).includes(rawCredential), false);
  }
});

test("fails closed for repository or permission scope expansion", async () => {
  const repositoryMismatch = createGitHubAppInstallationSessionProvider({
    identity: { clientId: "control-client" },
    signer: signer(),
    fetchRequest: async () =>
      jsonResponse(tokenPayload({ repositories: [{ full_name: "rozkalnsandris/hermes-tech" }] })),
  });
  await assert.rejects(
    () => repositoryMismatch(scope(), observedAt),
    (error) => errorCode(error) === "TOKEN_SCOPE_MISMATCH",
  );

  for (const permissions of [
    { metadata: "read", pull_requests: "read" },
    { metadata: "read", pull_requests: "write", checks: "read" },
    { metadata: "read", pull_requests: "read", checks: "read", administration: "read" },
  ]) {
    const provider = createGitHubAppInstallationSessionProvider({
      identity: { clientId: "control-client" },
      signer: signer(),
      fetchRequest: async () => jsonResponse(tokenPayload({ permissions })),
    });
    await assert.rejects(() => provider(scope(), observedAt), (error) => errorCode(error) === "TOKEN_SCOPE_MISMATCH");
  }
});

test("rejects malformed or unusable token lease evidence", async () => {
  for (const expiresAt of ["not-a-date", "2026-08-11T20:30:30.000Z", "2026-08-11T22:30:00.000Z"]) {
    const provider = createGitHubAppInstallationSessionProvider({
      identity: { clientId: "control-client" },
      signer: signer(),
      fetchRequest: async () => jsonResponse(tokenPayload({ expires_at: expiresAt })),
    });
    await assert.rejects(
      () => provider(scope(), observedAt),
      (error) => ["TOKEN_MALFORMED_RESPONSE", "TOKEN_UNUSABLE"].includes(errorCode(error) ?? ""),
    );
  }

  const nonJsonProvider = createGitHubAppInstallationSessionProvider({
    identity: { clientId: "control-client" },
    signer: signer(),
    fetchRequest: async () => new Response("credential-body", { status: 201, headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(
    () => nonJsonProvider(scope(), observedAt),
    (error) =>
      error instanceof GitHubAppSessionError &&
      error.code === "TOKEN_MALFORMED_RESPONSE" &&
      !error.message.includes("credential-body"),
  );
});

test("maps token endpoint failures to fixed sanitized outcomes", async () => {
  const cases: readonly [number, string][] = [
    [401, "TOKEN_UNAUTHORIZED"],
    [403, "TOKEN_FORBIDDEN"],
    [404, "TOKEN_NOT_FOUND"],
    [422, "TOKEN_SCOPE_REJECTED"],
    [500, "TOKEN_EXCHANGE_FAILED"],
  ];
  for (const [status, expectedCode] of cases) {
    const provider = createGitHubAppInstallationSessionProvider({
      identity: { clientId: "control-client" },
      signer: signer(),
      fetchRequest: async () => jsonResponse({ remote: "do-not-copy" }, status),
    });
    await assert.rejects(
      () => provider(scope(), observedAt),
      (error) =>
        error instanceof GitHubAppSessionError &&
        error.code === expectedCode &&
        error.status === status &&
        !error.message.includes("do-not-copy"),
    );
  }
});

test("sanitizes signer and token transport failures and rejects invalid inputs", async () => {
  assert.throws(
    () =>
      createGitHubAppInstallationSessionProvider({
        identity: { clientId: " bad-client " },
        signer: signer(),
        fetchRequest: async () => jsonResponse(tokenPayload()),
      }),
    (error) => errorCode(error) === "INVALID_APP_IDENTITY",
  );

  const invalidTimeProvider = createGitHubAppInstallationSessionProvider({
    identity: { clientId: "control-client" },
    signer: signer(),
    fetchRequest: async () => jsonResponse(tokenPayload()),
  });
  await assert.rejects(
    () => invalidTimeProvider(scope(), "not-a-time"),
    (error) => errorCode(error) === "INVALID_TIME",
  );

  const signingProvider = createGitHubAppInstallationSessionProvider({
    identity: { clientId: "control-client" },
    signer: { async signRs256() { throw new Error("private-signing-detail"); } },
    fetchRequest: async () => jsonResponse(tokenPayload()),
  });
  await assert.rejects(
    () => signingProvider(scope(), observedAt),
    (error) =>
      error instanceof GitHubAppSessionError &&
      error.code === "SIGNING_FAILED" &&
      !error.message.includes("private-signing-detail"),
  );

  const exchangeProvider = createGitHubAppInstallationSessionProvider({
    identity: { clientId: "control-client" },
    signer: signer(),
    fetchRequest: async () => { throw new Error("upstream-credential-detail"); },
  });
  await assert.rejects(
    () => exchangeProvider(scope(), observedAt),
    (error) =>
      error instanceof GitHubAppSessionError &&
      error.code === "TOKEN_EXCHANGE_FAILED" &&
      !error.message.includes("upstream-credential-detail"),
  );
});

test("authorized session integrates with bounded REST transport without returning raw credential", async () => {
  const requests: Request[] = [];
  const fetchRequest: GitHubAppCredentialFetch = async (request) => {
    requests.push(request.clone());
    if (request.method === "POST") return jsonResponse(tokenPayload());
    return jsonResponse({ number: 42, state: "open" }, 200);
  };
  const provider = createGitHubAppInstallationSessionProvider({
    identity: { clientId: "control-client" },
    signer: signer(),
    fetchRequest,
  });
  const readScope = scope();
  const transport = createGitHubRestReadTransport(provider);
  const request = createGitHubReadRequest(
    readScope,
    "rozkalnsandris/hermes-tech",
    "/repos/rozkalnsandris/hermes-tech/pulls/42",
    "pull_requests",
  );

  const result = await transport.get<{ number: number; state: string }>(readScope, request, observedAt);
  assert.deepEqual(result.pages, [{ number: 42, state: "open" }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[1].method, "GET");
  assert.equal(requests[1].url, "https://api.github.com/repos/rozkalnsandris/hermes-tech/pulls/42");
  assert.equal(requests[1].headers.get("authorization"), "Bearer test-only-opaque-installation-credential");
  assert.equal(JSON.stringify(result).includes("test-only-opaque-installation-credential"), false);
});

test("authorized session rejects off-origin and out-of-scope reads before HTTP", async () => {
  let fetchCount = 0;
  const provider = createGitHubAppInstallationSessionProvider({
    identity: { clientId: "control-client" },
    signer: signer(),
    fetchRequest: async (request) => {
      fetchCount += 1;
      return request.method === "POST" ? jsonResponse(tokenPayload()) : jsonResponse({ ok: true }, 200);
    },
  });
  const session = await provider(scope(), observedAt);
  assert.equal(fetchCount, 1);

  for (const url of [
    "https://example.invalid/repos/rozkalnsandris/hermes-tech/pulls/42",
    "https://api.github.com/repos/rozkalnsandris/hermes-deals/pulls/42",
  ]) {
    await assert.rejects(
      () =>
        session.execute({
          method: "GET",
          url,
          accept: GITHUB_REST_ACCEPT,
          apiVersion: GITHUB_REST_API_VERSION,
          redirect: "manual",
        }),
      (error) => errorCode(error) === "READ_REQUEST_INVALID",
    );
  }
  assert.equal(fetchCount, 1);
});
