import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubAppPullRequestWriteSessionProvider,
  GitHubAppPullRequestWriteSessionError,
  type GitHubAppAuthorizedPullRequestWriteSession,
} from "../src/integrations/github/app-installation-review-session.js";
import {
  GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
  GITHUB_REQUEST_CHANGES_EVENT,
  type GitHubAuthorizedRestPost,
} from "../src/integrations/github/pull-request-review-write.js";
import { GITHUB_REST_API_VERSION } from "../src/integrations/github/app-installation-read-contract.js";
import { GITHUB_REST_ACCEPT } from "../src/integrations/github/rest-read-transport.js";

const INSTALLATION_ID = 153121564;
const REPOSITORY = "rozkalnsandris/hermes-tech";
const NOW = "2026-08-16T14:10:00.000Z";
const EXPIRES = "2026-08-16T15:09:00.000Z";
const OPAQUE_TOKEN = "opaque_stateless-installation-token.with_nonlegacy_length_123456789";
const HEAD = "1111111111111111111111111111111111111111";

function jsonResponse(payload: unknown, status = 201): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function tokenPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: OPAQUE_TOKEN,
    expires_at: EXPIRES,
    repositories: [{ full_name: REPOSITORY }],
    permissions: { pull_requests: "write" },
    ...overrides,
  };
}

function dependencies(fetchRequest: (request: Request) => Promise<Response>) {
  return {
    identity: { clientId: "Iv23exampleClientId" },
    signer: {
      async signRs256(): Promise<Uint8Array> {
        return new Uint8Array([1, 2, 3, 4]);
      },
    },
    fetchRequest,
  } as const;
}

function scope() {
  return {
    repository: REPOSITORY,
    permission: GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
  } as const;
}

function writeRequest(overrides: Partial<GitHubAuthorizedRestPost> = {}): GitHubAuthorizedRestPost {
  return {
    method: "POST",
    url: `https://api.github.com/repos/${REPOSITORY}/pulls/48/reviews`,
    accept: GITHUB_REST_ACCEPT,
    apiVersion: GITHUB_REST_API_VERSION,
    contentType: "application/json",
    redirect: "manual",
    requiredPermission: GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
    body: JSON.stringify({
      commit_id: HEAD,
      body: "Please address the reviewed issues.",
      event: GITHUB_REQUEST_CHANGES_EVENT,
    }),
    ...overrides,
  };
}

async function expectSessionError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof GitHubAppPullRequestWriteSessionError && error.code === code,
  );
}

test("mints an exact one-repository pull_requests:write token and keeps opaque credential internal", async () => {
  const requests: Request[] = [];
  const provider = createGitHubAppPullRequestWriteSessionProvider(
    dependencies(async (request) => {
      requests.push(request);
      if (request.url.includes("/access_tokens")) return jsonResponse(tokenPayload());
      return jsonResponse({ state: "CHANGES_REQUESTED" }, 200);
    }),
    INSTALLATION_ID,
  );

  const session = (await provider(scope(), NOW)) as GitHubAppAuthorizedPullRequestWriteSession;
  assert.equal(requests.length, 1);

  const tokenRequest = requests[0];
  assert.equal(tokenRequest.method, "POST");
  assert.equal(tokenRequest.redirect, "manual");
  assert.equal(
    tokenRequest.url,
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
  );
  assert.equal(tokenRequest.headers.get("accept"), GITHUB_REST_ACCEPT);
  assert.equal(tokenRequest.headers.get("x-github-api-version"), GITHUB_REST_API_VERSION);
  assert.match(tokenRequest.headers.get("authorization") ?? "", /^Bearer eyJ/);
  assert.deepEqual(JSON.parse(await tokenRequest.clone().text()), {
    repositories: ["hermes-tech"],
    permissions: { pull_requests: "write" },
  });

  assert.deepEqual(session.credentialLease, {
    installationId: INSTALLATION_ID,
    repository: REPOSITORY,
    permission: GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
    metadataPermission: null,
    issuedAt: NOW,
    expiresAt: EXPIRES,
  });
  assert.doesNotMatch(JSON.stringify(session), new RegExp(OPAQUE_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const response = await session.execute(writeRequest());
  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  const write = requests[1];
  assert.equal(write.headers.get("authorization"), `Bearer ${OPAQUE_TOKEN}`);
  assert.equal(write.redirect, "manual");
  assert.deepEqual(JSON.parse(await write.clone().text()), {
    commit_id: HEAD,
    body: "Please address the reviewed issues.",
    event: "REQUEST_CHANGES",
  });
});

test("accepts GitHub metadata:read evidence only as the sole optional extra permission", async () => {
  const provider = createGitHubAppPullRequestWriteSessionProvider(
    dependencies(async () =>
      jsonResponse(tokenPayload({ permissions: { pull_requests: "write", metadata: "read" } })),
    ),
    INSTALLATION_ID,
  );

  const session = (await provider(scope(), NOW)) as GitHubAppAuthorizedPullRequestWriteSession;
  assert.equal(session.credentialLease.metadataPermission, "read");
});

test("rejects any broader token permission evidence", async () => {
  for (const permissions of [
    { pull_requests: "write", contents: "read" },
    { pull_requests: "write", issues: "write" },
    { pull_requests: "read" },
    { pull_requests: "write", metadata: "write" },
  ]) {
    const provider = createGitHubAppPullRequestWriteSessionProvider(
      dependencies(async () => jsonResponse(tokenPayload({ permissions }))),
      INSTALLATION_ID,
    );
    await expectSessionError(provider(scope(), NOW), "TOKEN_SCOPE_MISMATCH");
  }
});

test("rejects repository mismatch and more than one repository in returned credential evidence", async () => {
  for (const repositories of [
    [{ full_name: "rozkalnsandris/hermes-deals" }],
    [{ full_name: REPOSITORY }, { full_name: "rozkalnsandris/hermes-deals" }],
  ]) {
    const provider = createGitHubAppPullRequestWriteSessionProvider(
      dependencies(async () => jsonResponse(tokenPayload({ repositories }))),
      INSTALLATION_ID,
    );
    await expectSessionError(provider(scope(), NOW), "TOKEN_SCOPE_MISMATCH");
  }
});

test("rejects malformed, nearly expired and overlong credential leases without exposing token bytes", async () => {
  const cases = [
    tokenPayload({ token: "bad\ncredential" }),
    tokenPayload({ expires_at: "2026-08-16T14:10:30.000Z" }),
    tokenPayload({ expires_at: "2026-08-16T15:11:00.000Z" }),
  ];

  for (const payload of cases) {
    const provider = createGitHubAppPullRequestWriteSessionProvider(
      dependencies(async () => jsonResponse(payload)),
      INSTALLATION_ID,
    );
    await assert.rejects(provider(scope(), NOW), (error: unknown) => {
      assert.ok(error instanceof GitHubAppPullRequestWriteSessionError);
      assert.doesNotMatch(error.message, /opaque_stateless|bad\s*credential/i);
      return ["TOKEN_MALFORMED_RESPONSE", "TOKEN_UNUSABLE"].includes(error.code);
    });
  }
});

test("rejects unmanaged repository scope before signing or network access", async () => {
  let fetchCalls = 0;
  let signCalls = 0;
  const provider = createGitHubAppPullRequestWriteSessionProvider(
    {
      identity: { clientId: "Iv23exampleClientId" },
      signer: {
        async signRs256(): Promise<Uint8Array> {
          signCalls += 1;
          return new Uint8Array([1]);
        },
      },
      async fetchRequest(): Promise<Response> {
        fetchCalls += 1;
        return jsonResponse(tokenPayload());
      },
    },
    INSTALLATION_ID,
  );

  await expectSessionError(
    provider(
      {
        repository: "rozkalnsandris/hermes-email-skill",
        permission: GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
      },
      NOW,
    ),
    "INVALID_SCOPE",
  );
  assert.equal(signCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("authorized session accepts only exact GitHub review endpoint/manual request and is one-shot", async () => {
  const requests: Request[] = [];
  const provider = createGitHubAppPullRequestWriteSessionProvider(
    dependencies(async (request) => {
      requests.push(request);
      if (request.url.includes("/access_tokens")) return jsonResponse(tokenPayload());
      return new Response(null, { status: 200 });
    }),
    INSTALLATION_ID,
  );

  for (const invalid of [
    writeRequest({ url: "https://attacker.example/repos/rozkalnsandris/hermes-tech/pulls/48/reviews" }),
    writeRequest({ url: "https://api.github.com/repos/rozkalnsandris/hermes-deals/pulls/48/reviews" }),
    writeRequest({ url: `https://api.github.com/repos/${REPOSITORY}/issues/48/comments` }),
    writeRequest({ redirect: "follow" as "manual" }),
    writeRequest({ requiredPermission: "contents:write" as typeof GITHUB_PULL_REQUESTS_WRITE_PERMISSION }),
    writeRequest({ body: JSON.stringify({ commit_id: HEAD, body: "x", event: "APPROVE" }) }),
  ]) {
    const session = await provider(scope(), NOW);
    const before = requests.length;
    await expectSessionError(session.execute(invalid), "WRITE_REQUEST_INVALID");
    assert.equal(requests.length, before);
  }

  const session = await provider(scope(), NOW);
  await session.execute(writeRequest());
  const afterFirst = requests.length;
  await expectSessionError(session.execute(writeRequest()), "WRITE_REQUEST_INVALID");
  assert.equal(requests.length, afterFirst);
});

test("token exchange and write transport failures stay bounded and never echo credentials", async () => {
  for (const [status, code] of [
    [401, "TOKEN_UNAUTHORIZED"],
    [403, "TOKEN_FORBIDDEN"],
    [404, "TOKEN_NOT_FOUND"],
    [422, "TOKEN_SCOPE_REJECTED"],
    [500, "TOKEN_EXCHANGE_FAILED"],
  ] as const) {
    const provider = createGitHubAppPullRequestWriteSessionProvider(
      dependencies(async () => jsonResponse({ message: OPAQUE_TOKEN }, status)),
      INSTALLATION_ID,
    );
    await assert.rejects(provider(scope(), NOW), (error: unknown) => {
      assert.ok(error instanceof GitHubAppPullRequestWriteSessionError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /opaque_stateless/);
      return true;
    });
  }

  let call = 0;
  const provider = createGitHubAppPullRequestWriteSessionProvider(
    dependencies(async () => {
      call += 1;
      if (call === 1) return jsonResponse(tokenPayload());
      throw new Error(`network failed with ${OPAQUE_TOKEN}`);
    }),
    INSTALLATION_ID,
  );
  const session = await provider(scope(), NOW);
  await assert.rejects(session.execute(writeRequest()), (error: unknown) => {
    assert.ok(error instanceof GitHubAppPullRequestWriteSessionError);
    assert.equal(error.code, "WRITE_TRANSPORT_FAILED");
    assert.doesNotMatch(error.message, /opaque_stateless/);
    return true;
  });
});
