import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const preflightModuleUrl = pathToFileURL(
  path.join(process.cwd(), "scripts/github-app-needs-changes-preflight.mjs"),
).href;
const {
  GitHubAppNeedsChangesPreflightError,
  createGitHubAppJwt,
  readExactMainCiServerTime,
} = (await import(preflightModuleUrl)) as typeof import("../scripts/github-app-needs-changes-preflight.mjs");

function testPrivateKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
}

function decodeJwtPayload(jwt: string) {
  const [, payloadPart] = jwt.split(".");
  assert.ok(payloadPart);
  return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
}

function ciPayload(expectedSha: string, expectedCiRunId: number) {
  return {
    id: expectedCiRunId,
    name: "CI",
    event: "push",
    head_branch: "main",
    head_sha: expectedSha,
    status: "completed",
    conclusion: "success",
  };
}

async function expectPreflightCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof GitHubAppNeedsChangesPreflightError, true);
    assert.equal((error as InstanceType<typeof GitHubAppNeedsChangesPreflightError>).code, code);
    return true;
  });
}

test("exact-main CI GitHub Date anchors a conservative five-minute App JWT despite +97s local skew", async () => {
  const expectedSha = "800c20c9d85b1b1871637665f274bd617a30c696";
  const expectedCiRunId = 31975149382;
  const serverDate = "Sun, 16 Aug 2026 22:01:40 GMT";
  const expectedServerTimeMs = Date.parse(serverDate);
  const simulatedLocalNowMs = expectedServerTimeMs + 97_000;
  const requests: Request[] = [];

  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push(request);
    return Response.json(ciPayload(expectedSha, expectedCiRunId), {
      headers: { Date: serverDate },
    });
  }) as typeof fetch;

  const serverTimeMs = await readExactMainCiServerTime(fetchImpl, expectedSha, expectedCiRunId);
  assert.equal(serverTimeMs, expectedServerTimeMs);
  assert.equal(simulatedLocalNowMs - serverTimeMs, 97_000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.headers.has("authorization"), false);

  const payload = decodeJwtPayload(createGitHubAppJwt(testPrivateKey(), serverTimeMs, 5 * 60));
  const serverSeconds = Math.floor(serverTimeMs / 1000);
  assert.equal(payload.iat, serverSeconds - 60);
  assert.equal(payload.exp, serverSeconds + 300);
});

test("missing or malformed GitHub Date fails closed after exact-main CI validation", async () => {
  const expectedSha = "800c20c9d85b1b1871637665f274bd617a30c696";
  const expectedCiRunId = 31975149382;

  const missingDateFetch = (async (): Promise<Response> =>
    Response.json(ciPayload(expectedSha, expectedCiRunId))) as typeof fetch;
  await expectPreflightCode(
    readExactMainCiServerTime(missingDateFetch, expectedSha, expectedCiRunId),
    "GITHUB_SERVER_TIME_UNAVAILABLE",
  );

  const malformedDateFetch = (async (): Promise<Response> =>
    Response.json(ciPayload(expectedSha, expectedCiRunId), {
      headers: { Date: "not-a-valid-http-date" },
    })) as typeof fetch;
  await expectPreflightCode(
    readExactMainCiServerTime(malformedDateFetch, expectedSha, expectedCiRunId),
    "GITHUB_SERVER_TIME_UNAVAILABLE",
  );
});

test("CI drift fails before GitHub server time can be trusted", async () => {
  const expectedSha = "800c20c9d85b1b1871637665f274bd617a30c696";
  const expectedCiRunId = 31975149382;
  const fetchImpl = (async (): Promise<Response> =>
    Response.json(
      {
        ...ciPayload(expectedSha, expectedCiRunId),
        head_sha: "0bf5334bce6d2e1c017093620e07a5d845ea1eb2",
      },
      { headers: { Date: "Sun, 16 Aug 2026 22:01:40 GMT" } },
    )) as typeof fetch;

  await expectPreflightCode(
    readExactMainCiServerTime(fetchImpl, expectedSha, expectedCiRunId),
    "CI_RUN_DRIFT",
  );
});

test("live OBSERVE source wires exact-main CI server time into a five-minute JWT without adding a time endpoint", async () => {
  const source = await readFile(
    path.join(process.cwd(), "scripts/github-app-needs-changes-preflight.mjs"),
    "utf8",
  );

  assert.match(
    source,
    /const githubServerTimeMs = await readExactMainCiServerTime\(fetch, expectedSha, expectedCiRunId\);/,
  );
  assert.match(source, /nowMs: githubServerTimeMs/);
  assert.match(source, /jwtLifetimeSeconds: OBSERVE_JWT_LIFETIME_SECONDS/);
  assert.match(source, /const OBSERVE_JWT_LIFETIME_SECONDS = 5 \* 60;/);
  assert.equal(source.includes("/rate_limit"), false);
  assert.equal(source.includes("/meta"), false);
});
