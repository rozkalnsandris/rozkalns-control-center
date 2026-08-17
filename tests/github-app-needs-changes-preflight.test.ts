import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify as verifyRsaSha256 } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const preflightModuleUrl = pathToFileURL(
  path.join(process.cwd(), "scripts/github-app-needs-changes-preflight.mjs"),
).href;
const {
  GitHubAppNeedsChangesPreflightError,
  PREFLIGHT_CONTRACT,
  createGitHubAppJwt,
  observeGitHubAppState,
} = (await import(preflightModuleUrl)) as typeof import("../scripts/github-app-needs-changes-preflight.mjs");

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

interface UnexpectedResponse {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body?: Record<string, unknown>;
}

function createMockFetch(options: {
  readonly app?: Record<string, unknown>;
  readonly installation?: Record<string, unknown>;
  readonly excludedInstalled?: boolean;
  readonly extraRepositories?: string[];
  readonly unexpectedResponse?: UnexpectedResponse;
} = {}) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    const requestPath = `${url.pathname}${url.search}`;
    const body = request.method === "POST" ? await request.clone().json() : null;
    requests.push({
      method: request.method,
      path: requestPath,
      authorization: request.headers.get("authorization"),
      body,
    });

    const unexpected = options.unexpectedResponse;
    if (unexpected && unexpected.method === request.method && unexpected.path === requestPath) {
      return Response.json(unexpected.body ?? { message: "sensitive-upstream-body" }, {
        status: unexpected.status,
      });
    }

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
    assert.equal((error as InstanceType<typeof GitHubAppNeedsChangesPreflightError>).code, code);
    return true;
  });
}

async function expectLocalizedStatus(
  unexpectedResponse: UnexpectedResponse,
  expectedCode: string,
) {
  const { privateKey } = testPrivateKey();
  const sensitiveBodyValue = "upstream-detail-must-not-leak";
  const { fetchImpl } = createMockFetch({
    unexpectedResponse: {
      ...unexpectedResponse,
      body: { message: sensitiveBodyValue, documentation_url: `https://example.invalid/${sensitiveBodyValue}` },
    },
  });

  await assert.rejects(
    observeGitHubAppState({ fetchImpl, privateKeyPem: privateKey }),
    (error: unknown) => {
      assert.equal(error instanceof GitHubAppNeedsChangesPreflightError, true);
      const typed = error as InstanceType<typeof GitHubAppNeedsChangesPreflightError>;
      assert.equal(typed.code, expectedCode);
      assert.equal(typed.message, expectedCode);
      assert.equal(typed.code.includes(sensitiveBodyValue), false);
      assert.equal(typed.message.includes(sensitiveBodyValue), false);
      return true;
    },
  );
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

test("unexpected App status is localized without upstream body leakage", async () => {
  await expectLocalizedStatus(
    { method: "GET", path: "/app", status: 401 },
    "UNEXPECTED_STATUS:APP:401",
  );
});

test("unexpected installation status is localized without changing endpoint semantics", async () => {
  await expectLocalizedStatus(
    {
      method: "GET",
      path: `/app/installations/${PREFLIGHT_CONTRACT.installationId}`,
      status: 404,
    },
    "UNEXPECTED_STATUS:INSTALLATION:404",
  );
});

test("unexpected managed repository installation status identifies only the fixed repository and status", async () => {
  const repository = PREFLIGHT_CONTRACT.managedRepositories[0];
  assert.ok(repository);
  await expectLocalizedStatus(
    {
      method: "GET",
      path: `/repos/${PREFLIGHT_CONTRACT.owner}/${repository}/installation`,
      status: 301,
    },
    `UNEXPECTED_STATUS:REPOSITORY_INSTALLATION:${repository}:301`,
  );
});

test("unexpected token-mint status is localized without exposing token endpoint response", async () => {
  await expectLocalizedStatus(
    {
      method: "POST",
      path: `/app/installations/${PREFLIGHT_CONTRACT.installationId}/access_tokens`,
      status: 403,
    },
    "UNEXPECTED_STATUS:TOKEN_MINT:403",
  );
});

test("unexpected installation-repository inventory status is localized", async () => {
  await expectLocalizedStatus(
    {
      method: "GET",
      path: "/installation/repositories?per_page=100&page=1",
      status: 401,
    },
    "UNEXPECTED_STATUS:INSTALLATION_REPOSITORIES:401",
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

test("unexpected excluded-repository status is localized while 404 remains the required absent state", async () => {
  await expectLocalizedStatus(
    {
      method: "GET",
      path: `/repos/${PREFLIGHT_CONTRACT.owner}/${PREFLIGHT_CONTRACT.excludedRepository}/installation`,
      status: 403,
    },
    "UNEXPECTED_STATUS:EXCLUDED_REPOSITORY_INSTALLATION:403",
  );
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

test("source boundary wires the Needs changes route while every project capability remains inactive", async () => {
  const [workerIndex, wrangler, projectPolicy] = await Promise.all([
    readFile(path.join(process.cwd(), "src/worker/index.ts"), "utf8"),
    readFile(path.join(process.cwd(), "wrangler.jsonc"), "utf8"),
    readFile(path.join(process.cwd(), "src/shared/project-policy.ts"), "utf8"),
  ]);

  assert.equal(workerIndex.includes("github-needs-changes-route"), true);
  assert.equal(workerIndex.includes("GITHUB_NEEDS_CHANGES_ROUTE_PATH"), true);
  assert.equal(wrangler.includes("CONTROL_NEEDS_CHANGES_ACCESS_ISSUER"), true);
  assert.equal(wrangler.includes("CONTROL_NEEDS_CHANGES_ACCESS_AUDIENCE"), true);
  assert.equal(wrangler.includes("\"CONTROL_ACCESS_ISSUER\""), false);
  assert.equal(wrangler.includes("\"CONTROL_ACCESS_AUDIENCE\""), false);
  assert.equal((projectPolicy.match(/canRequestChanges: true/g) ?? []).length, 0);
  assert.equal((projectPolicy.match(/canRequestChanges: false/g) ?? []).length, 6);
});
