import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const helperUrl = pathToFileURL(resolve("scripts/cloudflare-access-app-identity.mjs")).href;

function runHelper(body: string) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `import * as helper from ${JSON.stringify(helperUrl)};\n${body}`],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

function protects(uri: string, host: string) {
  const app = { destinations: [{ type: "public", uri }] };
  const result = runHelper(
    `console.log(helper.accessApplicationProtectsHost(${JSON.stringify(app)}, ${JSON.stringify(host)}));`,
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("parent host proof accepts exact and documented one-level subdomain wildcard coverage", () => {
  assert.equal(protects("control.rozkalns.net", "control.rozkalns.net"), "true");
  assert.equal(protects("control.rozkalns.net/*", "control.rozkalns.net"), "true");
  assert.equal(protects("*.rozkalns.net", "control.rozkalns.net"), "true");
  assert.equal(protects("*.rozkalns.net/*", "control.rozkalns.net"), "true");
});

test("parent host proof keeps apex, deeper, partial and path-scoped wildcard cases fail-closed", () => {
  assert.equal(protects("*.rozkalns.net", "rozkalns.net"), "false");
  assert.equal(protects("*.rozkalns.net", "deep.control.rozkalns.net"), "false");
  assert.equal(protects("*control.rozkalns.net", "control.rozkalns.net"), "false");
  assert.equal(protects("*.*.rozkalns.net", "control.rozkalns.net"), "false");
  assert.equal(protects("*.rozkalns.net/api/*", "control.rozkalns.net"), "false");
  assert.equal(protects("*.example.net", "control.rozkalns.net"), "false");
});

test("parent host proof rejects invalid expected-host shapes", () => {
  const app = { destinations: [{ type: "public", uri: "*.rozkalns.net" }] };
  for (const host of ["", "https://control.rozkalns.net/path", "*.rozkalns.net", "control..rozkalns.net"] ) {
    const result = runHelper(
      `console.log(helper.accessApplicationProtectsHost(${JSON.stringify(app)}, ${JSON.stringify(host)}));`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "false");
  }
});
