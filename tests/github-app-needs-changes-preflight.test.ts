import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify as verifyRsaSha256 } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  GitHubAppNeedsChangesPreflightError,
  PREFLIGHT_CONTRACT,
  createGitHubAppJwt,
  observeGitHubAppState,
} from "../scripts/github-app-needs-changes-preflight.mjs";

const permissions = {
  actions: "read",
  checks: "read",
  contents: "read",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
} as const;

function appPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: PREFLIGHT_CONTRACT.appId,
    client_id: PREFLIGHT_CONTRACT.clientId,
    name: PREFLIGHT_CONTRACT.appName,
    permissions,
    ...overrides,
  };
}

function installationPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: PREFLIGHT_CONTRACT.installationId,
    app_id: PREFLIGHT_CONTRACT.appId,
    client_id: PREFLIGHT_CONTRACT.clientId,
    account: { login: PREFLIGHT_CONTRACT.owner },
    repository_selection: "selected",
    suspended_at: null,
    permissions,
    ...overrides,
  };
}

function inventoryPayload(extraRepositories: string[] = []) {
  const repositories = [
    ...PREFLIGHT_CONTRACT.managedRepositories.map((repository) => ({
      full_name: `${PREFLIGHT_CONTRACT.owner}/${repository}`,
    })),
    ...extraRepositories.map((full_name) => ({ full_name })),
  ];
  return { total_count: repositories.length, repositories };
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function createMockFetch(options: {
  readonly app?: Record<string, unknown>;
  readonly installation?: Record<string, unknown>;
  readonly excludedInstalled?: boolean;
  readonly extraRepositories?: string[];
} = {}) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.clone().json() : null;
    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get("authorization"),
      body,
    });

    if (url.pathname === "/app" && request.method === "GET") {
      return Response.json(options.app ?? appPayload());
    }
    if (
      url.pathname === `/app/installations/${PREFLIGHT_CONTRACT.installationId}` &&
      request.method === "GET"
    ) {
      return Response.json(options.installation ?? installationPayload());
    }
    if (url.pathname.startsWith(`/repos/${PREFLIGHT_CONTRACT.owner}/`) && url.pathname.endsWith("/installation")) {
      const repository = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (repository === PREFLIGHT_CONTRACT.excludedRepository) {
        if (options.excludedInstalled) return Response.json(installationPayload());
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (PREFLIGHT_CONTRACT.managedRepositories.includes(repository)) {
        return Response.json(options.installation ?? installationPayload());
      }
    }
    if (
      url.pathname === `/app/installations/${PREFLIGHT_CONTRACT.installationId}/access_tokens` &&
      request.method === "POST"
    ) {
      return Response.json(
        {
          token: "test-read-token-value",
          expires_at: "2026-08-16T23:59:00Z",
          permissions: { metadata: "read" },
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/installation/repositories" && request.method === "GET") {
      return Response.json(inventoryPayload(options.extraRepositories));
    }
    return Response.json({ message: "Unexpected test request" }, { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function testPrivateKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

async function expectPreflightCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof GitHubAppNeedsChangesPreflightError, true);
    assert.equal((error as GitHubAppNeedsChangesPreflightError).code, code);
    return true;
  });
}

test("GitHub App JWT uses RS256, client id issuer and bounded lifetime", () => {
  const { privateKey, publicKey } = testPrivateKey();
  const nowMs = Date.parse("2026-08-16T21:30:00Z");
  const jwt = createGitHubAppJwt(privateKey, nowMs);
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  assert.ok(headerPart && payloadPart && signaturePart);
  assert.deepEqual(JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")), {
    alg: "RS256",
    typ: "JWT",
  });
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
  const nowSeconds = Math.floor(nowMs / 1000);
  assert.equal(payload.iss, PREFLIGHT_CONTRACT.clientId);
  assert.equal(payload.iat, nowSeconds - 60);
  assert.equal(payload.exp, nowSeconds + 540);
  assert.equal(
    verifyRsaSha256(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      Buffer.from(signaturePart, "base64url"),
    ),
    true,
  );
});

test("OBSERVE contract proves exact read-only App state and uses only one metadata-read token mint", async () => {
  const { privateKey } = testPrivateKey();
  const { fetchImpl, requests } = createMockFetch();
  const result = await observeGitHubAppState({
    fetchImpl,
    privateKeyPem: privateKey,
    nowMs: Date.parse("2026-08-16T21:30:00Z"),
  });

  assert.equal(result.remoteConfigurationMutation, false);
  assert.equal(result.ephemeralReadCredentialIssued, true);
  assert.deepEqual(result.repositories, PREFLIGHT_CONTRACT.managedRepositories);
  assert.deepEqual(result.permissions, permissions);
  assert.equal(result.proposedPermissionDelta, "pull_requests:read->write");
  assert.equal(JSON.stringify(result).includes("test-read-token-value"), false);

  const postRequests = requests.filter((request) => request.method === "POST");
  assert.equal(postRequests.length, 1);
  assert.equal(
    postRequests[0]?.path,
    `/app/installations/${PREFLIGHT_CONTRACT.installationId}/access_tokens`,
  );
  assert.deepEqual(postRequests[0]?.body, { permissions: { metadata: "read" } });

  const nonPostMethods = requests.filter((request) => request.method !== "POST").map((request) => request.method);
  assert.equal(nonPostMethods.every((method) => method === "GET"), true);

  const inventoryRequest = requests.at(-1);
  assert.equal(inventoryRequest?.path, "/installation/repositories?per_page=100&page=1");
  assert.equal(inventoryRequest?.authorization, "Bearer test-read-token-value");
  assert.equal(
    requests.slice(0, -1).some((request) => request.authorization === "Bearer test-read-token-value"),
    false,
  );
});

test("permission growth or selected-repository drift fails closed before readiness", async () => {
  const { privateKey } = testPrivateKey();

  const permissionDrift = createMockFetch({
    app: appPayload({ permissions: { ...permissions, pull_requests: "write" } }),
  });
  await expectPreflightCode(
    observeGitHubAppState({ fetchImpl: permissionDrift.fetchImpl, privateKeyPem: privateKey }),
    "APP_PERMISSION_DRIFT",
  );
  assert.equal(permissionDrift.requests.some((request) => request.method === "POST"), false);

  const repositoryDrift = createMockFetch({
    extraRepositories: ["rozkalnsandris/unexpected-repository"],
  });
  await expectPreflightCode(
    observeGitHubAppState({ fetchImpl: repositoryDrift.fetchImpl, privateKeyPem: privateKey }),
    "REPOSITORY_COUNT_DRIFT",
  );
});

test("explicitly excluded repository resolving to the installation fails before token mint", async () => {
  const { privateKey } = testPrivateKey();
  const { fetchImpl, requests } = createMockFetch({ excludedInstalled: true });
  await expectPreflightCode(
    observeGitHubAppState({ fetchImpl, privateKeyPem: privateKey }),
    "EXCLUDED_REPOSITORY_INSTALLED",
  );
  assert.equal(requests.some((request) => request.method === "POST"), false);
});

test("PLAN is credential-free, sanitized and does not imply activation", () => {
  const script = path.join(process.cwd(), "scripts/github-app-needs-changes-preflight.mjs");
  const secret = "test-private-key-must-not-appear";
  const output = execFileSync(process.execPath, [script, "--mode", "plan"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_APP_PRIVATE_KEY_PEM: secret },
  });
  assert.match(output, /MODE=PLAN/);
  assert.match(output, /PROPOSED_PERMISSION_DELTA=pull_requests:read->write/);
  assert.match(output, /PERMISSION_GROWTH=NO/);
  assert.match(output, /WORKER_DEPLOY=NO/);
  assert.equal(output.includes(secret), false);
});

test("source boundary keeps Needs changes production route/config/capabilities inactive", async () => {
  const [workerIndex, wrangler, projectPolicy] = await Promise.all([
    readFile(path.join(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFile(path.join(process.cwd(), "wrangler.jsonc"), "utf8"),
    readFile(path.join(process.cwd(), "src/shared/project-policy.ts"), "utf8"),
  ]);

  assert.equal(workerIndex.includes("github-needs-changes-route"), false);
  assert.equal(workerIndex.includes("GITHUB_NEEDS_CHANGES_ROUTE_PATH"), false);
  assert.equal(wrangler.includes("CONTROL_NEEDS_CHANGES"), false);
  assert.equal(wrangler.includes("CONTROL_ACCESS_ISSUER"), false);
  assert.equal(wrangler.includes("CONTROL_ACCESS_AUDIENCE"), false);
  assert.equal((projectPolicy.match(/canRequestChanges: true/g) ?? []).length, 0);
  assert.equal((projectPolicy.match(/canRequestChanges: false/g) ?? []).length, 6);
});
