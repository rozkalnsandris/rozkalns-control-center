import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubAppMergeSessionProvider,
  GitHubAppMergeSessionError,
  type GitHubAppAuthorizedMergeSession,
} from "../src/integrations/github/app-installation-merge-session.js";
import {
  GITHUB_CONTENTS_WRITE_PERMISSION,
  type GitHubAuthorizedRestPut,
} from "../src/integrations/github/pull-request-merge-write.js";
import { GITHUB_REST_API_VERSION } from "../src/integrations/github/app-installation-read-contract.js";
import { GITHUB_REST_ACCEPT } from "../src/integrations/github/rest-read-transport.js";

const INSTALLATION_ID = 153121564;
const REPOSITORY = "rozkalnsandris/hermes-tech";
const NOW = "2026-08-24T11:10:00.000Z";
const EXPIRES = "2026-08-24T12:09:00.000Z";
const OPAQUE_TOKEN = "opaque_merge-installation-token.with_nonlegacy_length_123456789";
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
    permissions: { contents: "write" },
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
  return { repository: REPOSITORY, permission: GITHUB_CONTENTS_WRITE_PERMISSION } as const;
}

function writeRequest(overrides: Partial<GitHubAuthorizedRestPut> = {}): GitHubAuthorizedRestPut {
  return {
    method: "PUT",
    url: `https://api.github.com/repos/${REPOSITORY}/pulls/48/merge`,
    accept: GITHUB_REST_ACCEPT,
    apiVersion: GITHUB_REST_API_VERSION,
    contentType: "application/json",
    redirect: "manual",
    requiredPermission: GITHUB_CONTENTS_WRITE_PERMISSION,
    body: JSON.stringify({ sha: HEAD, merge_method: "squash" }),
    ...overrides,
  };
}

async function expectSessionError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof GitHubAppMergeSessionError && error.code === code,
  );
}

test("mints an exact one-repository contents:write token and keeps the opaque credential internal", async () => {
  const requests: Request[] = [];
  const provider = createGitHubAppMergeSessionProvider(
    dependencies(async (request) => {
      requests.push(request);
      if (request.url.includes("/access_tokens")) return jsonResponse(tokenPayload());
      return jsonResponse({ sha: "2".repeat(40), merged: true }, 200);
    }),
    INSTALLATION_ID,
  );

  const session = (await provider(scope(), NOW)) as GitHubAppAuthorizedMergeSession;
  assert.equal(requests.length, 1);
  const tokenRequest = requests[0];
  assert.equal(tokenRequest.method, "POST");
  assert.equal(tokenRequest.redirect, "manual");
  assert.equal(tokenRequest.url, `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
  assert.equal(tokenRequest.headers.get("accept"), GITHUB_REST_ACCEPT);
  assert.equal(tokenRequest.headers.get("x-github-api-version"), GITHUB_REST_API_VERSION);
  assert.match(tokenRequest.headers.get("authorization") ?? "", /^Bearer eyJ/);
  assert.deepEqual(JSON.parse(await tokenRequest.clone().text()), {
    repositories: ["hermes-tech"],
    permissions: { contents: "write" },
  });

  assert.deepEqual(session.credentialLease, {
    installationId: INSTALLATION_ID,
    repository: REPOSITORY,
    permission: GITHUB_CONTENTS_WRITE_PERMISSION,
    metadataPermission: null,
    issuedAt: NOW,
    expiresAt: EXPIRES,
  });
  assert.doesNotMatch(JSON.stringify(session), new RegExp(OPAQUE_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const response = await session.execute(writeRequest());
  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  const write = requests[1];
  assert.equal(write.method, "PUT");
  assert.equal(write.headers.get("authorization"), `Bearer ${OPAQUE_TOKEN}`);
  assert.equal(write.redirect, "manual");
  assert.deepEqual(JSON.parse(await write.clone().text()), { sha: HEAD, merge_method: "squash" });
});

test("accepts metadata:read only as the sole optional extra returned permission", async () => {
  const provider = createGitHubAppMergeSessionProvider(
    dependencies(async () => jsonResponse(tokenPayload({ permissions: { contents: "write", metadata: "read" } }))),
    INSTALLATION_ID,
  );
  const session = (await provider(scope(), NOW)) as GitHubAppAuthorizedMergeSession;
  assert.equal(session.credentialLease.metadataPermission, "read");
});

test("rejects broader or weaker token permission evidence", async () => {
  for (const permissions of [
    { contents: "write", pull_requests: "write" },
    { contents: "write", issues: "write" },
    { contents: "read" },
    { contents: "write", metadata: "write" },
  ]) {
    const provider = createGitHubAppMergeSessionProvider(
      dependencies(async () => jsonResponse(tokenPayload({ permissions }))),
      INSTALLATION_ID,
    );
    await expectSessionError(provider(scope(), NOW), "TOKEN_SCOPE_MISMATCH");
  }
});

test("rejects repository mismatch and multi-repository credential evidence", async () => {
  for (const repositories of [
    [{ full_name: "rozkalnsandris/hermes-deals" }],
    [{ full_name: REPOSITORY }, { full_name: "rozkalnsandris/hermes-deals" }],
  ]) {
    const provider = createGitHubAppMergeSessionProvider(
      dependencies(async () => jsonResponse(tokenPayload({ repositories }))),
      INSTALLATION_ID,
    );
    await expectSessionError(provider(scope(), NOW), "TOKEN_SCOPE_MISMATCH");
  }
});

test("rejects unmanaged repository before signing or network access", async () => {
  let fetchCalls = 0;
  let signCalls = 0;
  const provider = createGitHubAppMergeSessionProvider(
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
    provider({ repository: "rozkalnsandris/hermes-email-skill", permission: GITHUB_CONTENTS_WRITE_PERMISSION }, NOW),
    "INVALID_SCOPE",
  );
  assert.equal(signCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("authorized Merge session accepts only exact endpoint/body and is one-shot", async () => {
  const requests: Request[] = [];
  const provider = createGitHubAppMergeSessionProvider(
    dependencies(async (request) => {
      requests.push(request);
      if (request.url.includes("/access_tokens")) return jsonResponse(tokenPayload());
      return new Response(null, { status: 200 });
    }),
    INSTALLATION_ID,
  );

  for (const invalid of [
    writeRequest({ url: "https://attacker.example/repos/rozkalnsandris/hermes-tech/pulls/48/merge" }),
    writeRequest({ url: "https://api.github.com/repos/rozkalnsandris/hermes-deals/pulls/48/merge" }),
    writeRequest({ url: `https://api.github.com/repos/${REPOSITORY}/pulls/48/reviews` }),
    writeRequest({ redirect: "follow" as "manual" }),
    writeRequest({ requiredPermission: "pull_requests:write" as typeof GITHUB_CONTENTS_WRITE_PERMISSION }),
    writeRequest({ body: JSON.stringify({ sha: HEAD, merge_method: "auto" }) }),
    writeRequest({ body: JSON.stringify({ sha: HEAD, merge_method: "squash", extra: true }) }),
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

test("token exchange and Merge transport failures stay bounded without credential leakage", async () => {
  for (const [status, code] of [
    [401, "TOKEN_UNAUTHORIZED"],
    [403, "TOKEN_FORBIDDEN"],
    [404, "TOKEN_NOT_FOUND"],
    [422, "TOKEN_SCOPE_REJECTED"],
    [500, "TOKEN_EXCHANGE_FAILED"],
  ] as const) {
    const provider = createGitHubAppMergeSessionProvider(
      dependencies(async () => jsonResponse({ message: OPAQUE_TOKEN }, status)),
      INSTALLATION_ID,
    );
    await assert.rejects(provider(scope(), NOW), (error: unknown) => {
      assert.ok(error instanceof GitHubAppMergeSessionError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /opaque_merge/);
      return true;
    });
  }

  let call = 0;
  const provider = createGitHubAppMergeSessionProvider(
    dependencies(async () => {
      call += 1;
      if (call === 1) return jsonResponse(tokenPayload());
      throw new Error(`network failed with ${OPAQUE_TOKEN}`);
    }),
    INSTALLATION_ID,
  );
  const session = await provider(scope(), NOW);
  await assert.rejects(session.execute(writeRequest()), (error: unknown) => {
    assert.ok(error instanceof GitHubAppMergeSessionError);
    assert.equal(error.code, "WRITE_TRANSPORT_FAILED");
    assert.doesNotMatch(error.message, /opaque_merge/);
    return true;
  });
});
