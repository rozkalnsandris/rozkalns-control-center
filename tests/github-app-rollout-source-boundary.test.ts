import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("GitHub App rollout manifest and declared production runtime bindings remain least-privilege", async () => {
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
    CONTROL_LIVE_READ_ENABLED: "true",
    CONTROL_WEBHOOK_RUNTIME_ENABLED: "true",
    CONTROL_NOTIFICATION_TRANSITIONS_ENABLED: "true",
    CONTROL_NOTIFICATION_TARGET_KEYS: '["primary"]',
    CONTROL_NOTIFICATION_DISPATCH_ENABLED: "true",
    CONTROL_NOTIFICATION_RETRY_POLICY:
      '{"schemaVersion":1,"maxAttempts":2,"retryDelaysSeconds":[60]}',
    CONTROL_TELEGRAM_TARGET_KEY: "primary",
    CONTROL_NOTIFICATION_CONTROL_ORIGIN: "https://control.rozkalns.net",
    CONTROL_NEEDS_CHANGES_ACCESS_ISSUER: "https://super-salad-2357.cloudflareaccess.com",
    CONTROL_NEEDS_CHANGES_ACCESS_AUDIENCE:
      "a8cce1f50660ab0f82afccb5d427be1107fc8b238b70cb67b57f00593493d6cc",
    CONTROL_MERGE_ACCESS_ISSUER: "https://super-salad-2357.cloudflareaccess.com",
    CONTROL_MERGE_ACCESS_AUDIENCE:
      "a8cce1f50660ab0f82afccb5d427be1107fc8b238b70cb67b57f00593493d6cc",
    CONTROL_LATER_ACCESS_ISSUER: "https://super-salad-2357.cloudflareaccess.com",
    CONTROL_LATER_ACCESS_AUDIENCE:
      "a8cce1f50660ab0f82afccb5d427be1107fc8b238b70cb67b57f00593493d6cc",
  });
  assert.equal(config.vars?.CONTROL_LIVE_READ_ENABLED, "true");
  assert.equal(config.vars?.CONTROL_WEBHOOK_RUNTIME_ENABLED, "true");
  assert.equal(
    config.vars?.CONTROL_NEEDS_CHANGES_ACCESS_ISSUER,
    "https://super-salad-2357.cloudflareaccess.com",
  );
  assert.equal(
    config.vars?.CONTROL_NEEDS_CHANGES_ACCESS_AUDIENCE,
    "a8cce1f50660ab0f82afccb5d427be1107fc8b238b70cb67b57f00593493d6cc",
  );
  assert.equal(
    config.vars?.CONTROL_MERGE_ACCESS_ISSUER,
    "https://super-salad-2357.cloudflareaccess.com",
  );
  assert.equal(
    config.vars?.CONTROL_MERGE_ACCESS_AUDIENCE,
    "a8cce1f50660ab0f82afccb5d427be1107fc8b238b70cb67b57f00593493d6cc",
  );
  assert.equal(
    config.vars?.CONTROL_LATER_ACCESS_ISSUER,
    "https://super-salad-2357.cloudflareaccess.com",
  );
  assert.equal(
    config.vars?.CONTROL_LATER_ACCESS_AUDIENCE,
    "a8cce1f50660ab0f82afccb5d427be1107fc8b238b70cb67b57f00593493d6cc",
  );
  assert.deepEqual(config.secrets?.required, [
    "GITHUB_APP_PRIVATE_KEY_PEM",
    "GITHUB_WEBHOOK_SECRET",
    "CONTROL_TELEGRAM_BOT_TOKEN",
    "CONTROL_TELEGRAM_CHAT_ID",
  ]);
  assert.doesNotMatch(wrangler, /-----BEGIN|ghs_|test-webhook-secret|contents:write/i);

  assert.doesNotMatch(worker, /app-read-rollout-plan|GitHubReadRollout|cloudflare-worker-runtime|GITHUB_APP_/);
});
