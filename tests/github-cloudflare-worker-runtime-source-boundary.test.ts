import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("Cloudflare GitHub runtime stays behind the Worker route boundary and contains no credential material", async () => {
  const [runtime, worker, wrangler] = await Promise.all([
    source("src/integrations/github/cloudflare-worker-runtime.ts"),
    source("src/worker/index.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(runtime, /from "node:crypto"/);
  assert.match(runtime, /GITHUB_APP_PRIVATE_KEY_PEM/);
  assert.match(runtime, /buildPhase2GitHubReadScopeForStage\(installationId, "actions"\)/);
  assert.doesNotMatch(runtime, /-----BEGIN|ghs_[A-Za-z0-9]/);
  assert.doesNotMatch(runtime, /wrangler|versions upload|secret put|deploy\(/i);

  assert.doesNotMatch(worker, /cloudflare-worker-runtime|GITHUB_APP_/);
  assert.match(worker, /request\.method === "GET" && url\.pathname === "\/api\/health"/);

  assert.match(wrangler, /"GITHUB_APP_PRIVATE_KEY_PEM"/);
  assert.doesNotMatch(wrangler, /-----BEGIN|ghs_[A-Za-z0-9]/);
});
