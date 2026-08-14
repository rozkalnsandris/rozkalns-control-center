import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONTROL_GITHUB_LIVE_READS_DISABLED,
  CONTROL_GITHUB_LIVE_READS_ENABLED,
  isGitHubLiveReadModeEnabled,
} from "../src/shared/public-runtime.js";

test("live GitHub reads require the exact enabled flag", () => {
  assert.equal(isGitHubLiveReadModeEnabled(CONTROL_GITHUB_LIVE_READS_ENABLED), true);
  for (const value of [undefined, "", CONTROL_GITHUB_LIVE_READS_DISABLED, "true", "ENABLED", " enabled "]) {
    assert.equal(isGitHubLiveReadModeEnabled(value), false);
  }
});

test("production fixture configuration pins live GitHub reads disabled", async () => {
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8")) as {
    vars?: Record<string, unknown>;
    workers_dev?: unknown;
    preview_urls?: unknown;
    routes?: unknown;
    route?: unknown;
  };

  assert.equal(config.vars?.CONTROL_GITHUB_LIVE_READS, CONTROL_GITHUB_LIVE_READS_DISABLED);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal("route" in config, false);
  assert.equal("routes" in config, false);
});

test("worker reconcile route checks the public-mode guard before live reconciliation", async () => {
  const source = await readFile("src/worker/index.ts", "utf8");

  const guardIndex = source.indexOf("isGitHubLiveReadModeEnabled(env.CONTROL_GITHUB_LIVE_READS)");
  const handlerIndex = source.indexOf("handleGitHubReconciliationRequest(request, env");
  assert.notEqual(guardIndex, -1);
  assert.notEqual(handlerIndex, -1);
  assert.ok(guardIndex < handlerIndex);
  assert.match(source, /return new Response\("Not Found", \{ status: 404 \}\)/);
});
