import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("GitHub App rollout manifest and declared runtime bindings remain least-privilege", async () => {
  const [rollout, worker, wrangler] = await Promise.all([
    source("src/integrations/github/app-read-rollout-plan.ts"),
    source("src/worker/index.ts"),
    source("wrangler.jsonc"),
  ]);
  const config = JSON.parse(wrangler) as {
    readonly vars?: Readonly<Record<string, string>>;
    readonly secrets?: { readonly required?: readonly string[] };
  };

  assert.match(rollout, /GITHUB_CONTROL_APP_NAME = "Rozkalns Control"/);
  assert.match(rollout, /GITHUB_CONTROL_REPOSITORY_SELECTION = "selected"/);
  assert.match(rollout, /LEGACY_COMMIT_STATUS_REQUIRED/);
  assert.match(rollout, /parseGitHubInstallationReadScope/);
  assert.doesNotMatch(rollout, /api\.github\.com|Authorization|Bearer|fetch\(/);
  assert.doesNotMatch(rollout, /\b(?:POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(rollout, /"administration"|"write"/);
  assert.doesNotMatch(rollout, /BEGIN (?:RSA )?PRIVATE KEY|ghs_/);

  assert.deepEqual(config.vars, {
    GITHUB_APP_CLIENT_ID: "Iv23likDoFtVeWBJfdFS",
    GITHUB_APP_INSTALLATION_ID: "153121564",
    CONTROL_LIVE_READ_ENABLED: "false",
  });
  assert.equal(config.vars?.CONTROL_LIVE_READ_ENABLED, "false");
  assert.deepEqual(config.secrets?.required, ["GITHUB_APP_PRIVATE_KEY_PEM"]);
  assert.doesNotMatch(wrangler, /-----BEGIN|ghs_/);

  assert.doesNotMatch(worker, /app-read-rollout-plan|GitHubReadRollout|cloudflare-worker-runtime|GITHUB_APP_/);
});
