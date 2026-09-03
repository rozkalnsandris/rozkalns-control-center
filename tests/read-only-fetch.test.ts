import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlReadError,
  readControlJson,
  type ControlReadFailureCode,
} from "../src/react-app/read-only-fetch.js";

interface Payload { readonly ok: true }
const valid = (value: unknown): value is Payload =>
  typeof value === "object" && value !== null && "ok" in value && value.ok === true;

async function expectCode(code: ControlReadFailureCode, action: () => Promise<unknown>): Promise<ControlReadError> {
  try {
    await action();
  } catch (error: unknown) {
    assert.equal(error instanceof ControlReadError, true);
    assert.equal((error as ControlReadError).code, code);
    return error as ControlReadError;
  }
  assert.fail(`Expected ${code}`);
}

test("read helper enforces same-origin GET/no-store policy for all three bounded paths", async () => {
  const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchRequest: typeof fetch = async (input, init) => {
    seen.push({ input, init });
    return Response.json({ ok: true });
  };

  for (const path of ["/api/health", "/api/github/dashboard", "/api/github/webhook-deliveries"] as const) {
    assert.deepEqual(await readControlJson(path, { validate: valid, fetchRequest }), { ok: true });
  }
  assert.deepEqual(seen.map((item) => item.input), ["/api/health", "/api/github/dashboard", "/api/github/webhook-deliveries"]);
  assert.ok(seen.every((item) => item.init?.method === "GET" && item.init.cache === "no-store"));
});

test("read helper distinguishes timeout from caller abort and network failure", async () => {
  const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await expectCode("TIMEOUT", () => readControlJson("/api/health", { validate: valid, fetchRequest: hangingFetch, timeoutMs: 5 }));

  const controller = new AbortController();
  const aborted = readControlJson("/api/health", { validate: valid, fetchRequest: hangingFetch, signal: controller.signal, timeoutMs: 1_000 });
  controller.abort();
  await expectCode("ABORTED", () => aborted);

  await expectCode("NETWORK", () => readControlJson("/api/health", { validate: valid, fetchRequest: async () => { throw new TypeError("offline"); } }));
});

test("read helper classifies server, invalid JSON and invalid schema failures", async () => {
  const server = await expectCode("SERVER", () => readControlJson("/api/github/dashboard", { validate: valid, fetchRequest: async () => Response.json({ error: "DOWN" }, { status: 503 }) }));
  assert.equal(server.status, 503);
  assert.deepEqual(server.payload, { error: "DOWN" });
  assert.equal((await expectCode("SERVER", () => readControlJson("/api/github/dashboard", { validate: valid, fetchRequest: async () => new Response("gateway", { status: 502 }) }))).status, 502);

  await expectCode("INVALID_JSON", () => readControlJson("/api/github/dashboard", { validate: valid, fetchRequest: async () => new Response("not-json", { status: 200 }) }));
  await expectCode("INVALID_SCHEMA", () => readControlJson("/api/github/dashboard", { validate: valid, fetchRequest: async () => Response.json({ ok: false }) }));
});

test("a later successful read recovers after an offline failure without automatic polling", async () => {
  let calls = 0;
  const fetchRequest: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("offline");
    return Response.json({ ok: true });
  };
  await expectCode("NETWORK", () => readControlJson("/api/health", { validate: valid, fetchRequest }));
  assert.deepEqual(await readControlJson("/api/health", { validate: valid, fetchRequest }), { ok: true });
  assert.equal(calls, 2);
});
