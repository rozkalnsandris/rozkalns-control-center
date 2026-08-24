import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const routeSource = readFileSync(resolve(process.cwd(), "src/worker/github-merge-route.ts"), "utf8");

test("detached Merge route keeps an exact bounded request contract", () => {
  assert.match(routeSource, /GITHUB_MERGE_HTTP_BODY_MAX_BYTES\s*=\s*4096/);
  assert.match(routeSource, /MERGE_REQUEST_ID_PATTERN/);
  assert.match(routeSource, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(routeSource, /GITHUB_MERGE_METHODS/);
  assert.match(routeSource, /Object\.keys\(record\)\.sort\(\)/);
  assert.match(routeSource, /JSON\.stringify\(keys\)\s*!==\s*JSON\.stringify\(REQUEST_KEYS\)/);
  assert.equal(routeSource.includes("Authorization:"), false);
  assert.equal(routeSource.includes("Bearer "), false);
});
