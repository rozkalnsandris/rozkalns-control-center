import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  API_CONTENT_SECURITY_POLICY,
  COMMON_BROWSER_SECURITY_HEADERS,
  applyApiResponseSecurityHeaders,
} from "../src/worker/response-security.js";

function assertCommonHeaders(response: Response): void {
  for (const [name, value] of Object.entries(COMMON_BROWSER_SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value);
  }
  assert.equal(response.headers.get("content-security-policy"), API_CONTENT_SECURITY_POLICY);
}

test("central API policy covers representative success and error responses without changing no-store", () => {
  const success = applyApiResponseSecurityHeaders(Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }));
  const error = applyApiResponseSecurityHeaders(Response.json({ error: "FAILED" }, { status: 503, headers: { "Cache-Control": "no-store" } }));
  assertCommonHeaders(success);
  assertCommonHeaders(error);
  assert.equal(success.headers.get("cache-control"), "no-store");
  assert.equal(error.headers.get("cache-control"), "no-store");
  assert.equal(error.status, 503);
});

test("static asset policy is restrictive, same-origin compatible and never enables wildcard CORS", async () => {
  const [headers, html, worker] = await Promise.all([
    readFile("public/_headers", "utf8"),
    readFile("index.html", "utf8"),
    readFile("src/worker/index.ts", "utf8"),
  ]);
  for (const [name, value] of Object.entries(COMMON_BROWSER_SECURITY_HEADERS)) {
    assert.match(headers, new RegExp(`${name}: ${value.replace(/[()]/g, "\\$&")}`));
  }
  assert.match(headers, /Content-Security-Policy: default-src 'self';/);
  assert.match(headers, /connect-src 'self'/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /object-src 'none'/);
  assert.match(headers, /script-src 'self'/);
  assert.match(headers, /style-src 'self'/);
  assert.doesNotMatch(headers, /Access-Control-Allow-Origin/);
  assert.doesNotMatch(html, /<script(?![^>]+\bsrc=)[^>]*>/i);
  assert.match(worker, /applyApiResponseSecurityHeaders\(await routeWorkerRequest\(request, env\)\)/);
});
