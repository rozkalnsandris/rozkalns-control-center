import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const PREFLIGHT_PATH = "scripts/phase5-worker-write-credential-preflight.mjs";
const TOKEN = "TOPSECRET_WRITE_TOKEN";
const ACCOUNT = "70e29dbca0e8363358659102d2b74178";
const WORKER = "rozkalns-control";

type ScenarioResult = {
  receipt: Record<string, unknown>;
  calls: Array<{ url: string; method: string; bearer: boolean }>;
};

function runScenario(scenario: string): ScenarioResult {
  const moduleUrl = pathToFileURL(resolve(PREFLIGHT_PATH)).href;
  const program = `
    import { runWriteCredentialPreflight } from ${JSON.stringify(moduleUrl)};
    const calls = [];
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method ?? "GET", bearer: String(options.headers?.Authorization ?? "").startsWith("Bearer ") });
      if (calls.length === 1) {
        if (${JSON.stringify(scenario)} === "network") throw new Error("TOPSECRET_NETWORK_DETAIL");
        if (${JSON.stringify(scenario)} === "timeout") {
          return await new Promise((_, reject) => {
            const keepAlive = setTimeout(() => reject(new Error("TOPSECRET_TIMEOUT_FALLBACK")), 100);
            options.signal.addEventListener("abort", () => {
              clearTimeout(keepAlive);
              reject(options.signal.reason);
            }, { once: true });
          });
        }
        if (${JSON.stringify(scenario)} === "malformed") return new Response("not-json", { status: 200 });
        if (${JSON.stringify(scenario)} === "inactive") return response({ success: true, result: { status: "disabled", id: "SECRET_TOKEN_ID" } });
        return response({ success: true, result: { status: "active", id: "SECRET_TOKEN_ID" } });
      }
      if (${JSON.stringify(scenario)} === "target403") return response({ success: false, errors: [{ code: 10000, message: "TOPSECRET_FORBIDDEN_DETAIL" }] }, 403);
      return response({ success: true, result: { items: [] } });
    };
    const receipt = await runWriteCredentialPreflight({ token: ${JSON.stringify(TOKEN)}, accountId: ${JSON.stringify(ACCOUNT)}, workerName: ${JSON.stringify(WORKER)}, fetchImpl, timeoutMs: ${JSON.stringify(scenario)} === "timeout" ? 5 : 1000 });
    process.stdout.write(JSON.stringify({ receipt, calls }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.ok(!child.stdout.includes(TOKEN));
  assert.ok(!child.stdout.includes("SECRET_TOKEN_ID"));
  assert.ok(!child.stdout.includes("TOPSECRET_FORBIDDEN_DETAIL"));
  assert.ok(!child.stdout.includes("TOPSECRET_NETWORK_DETAIL"));
  return JSON.parse(child.stdout) as ScenarioResult;
}

test("write-credential preflight proves only active token plus exact-target GET reachability", () => {
  const { receipt, calls } = runScenario("success");
  assert.deepEqual(receipt, {
    schema_version: 1,
    ok: true,
    token_status: "ACTIVE",
    target_read: "PASS",
    write_permission_proven: false,
  });
  assert.deepEqual(calls, [
    { url: "https://api.cloudflare.com/client/v4/user/tokens/verify", method: "GET", bearer: true },
    { url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/versions?per_page=1`, method: "GET", bearer: true },
  ]);
});

test("write-credential preflight fails closed with sanitized bounded receipts", () => {
  assert.deepEqual(runScenario("inactive").receipt, {
    schema_version: 1,
    ok: false,
    code: "WORKERS_WRITE_CREDENTIAL_TOKEN_NOT_ACTIVE",
    http_status: null,
  });
  assert.deepEqual(runScenario("malformed").receipt, {
    schema_version: 1,
    ok: false,
    code: "WORKERS_WRITE_CREDENTIAL_VERIFY_JSON_INVALID",
    http_status: null,
  });
  assert.deepEqual(runScenario("network").receipt, {
    schema_version: 1,
    ok: false,
    code: "WORKERS_WRITE_CREDENTIAL_VERIFY_NETWORK_FAILED",
    http_status: null,
  });
  assert.deepEqual(runScenario("timeout").receipt, {
    schema_version: 1,
    ok: false,
    code: "WORKERS_WRITE_CREDENTIAL_VERIFY_NETWORK_FAILED",
    http_status: null,
  });
  assert.deepEqual(runScenario("target403").receipt, {
    schema_version: 1,
    ok: false,
    code: "WORKERS_WRITE_CREDENTIAL_TARGET_READ_HTTP_NOT_200",
    http_status: 403,
  });
});

test("write-credential preflight source has GET-only Cloudflare paths and no mutation verbs", () => {
  const source = readFileSync(PREFLIGHT_PATH, "utf8");
  assert.match(source, /user\/tokens\/verify/);
  assert.match(source, /versions\?per_page=1/);
  assert.match(source, /method: "GET"/);
  assert.match(source, /AbortSignal\.timeout\(timeoutMs\)/);
  assert.doesNotMatch(source, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(source, /console\.(?:log|error)/);
});
