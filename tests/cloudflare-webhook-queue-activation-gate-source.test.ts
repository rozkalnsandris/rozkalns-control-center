import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production activation gate is exact, one-shot and fail-closed", async () => {
  const [gate, identity, wrangler, runbook, shared] = await Promise.all([
    readFile("scripts/cloudflare-webhook-queue-activation-gate.mjs", "utf8"),
    readFile("scripts/cloudflare-access-app-identity.mjs", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
    readFile("docs/PHASE2_WEBHOOK_QUEUE_PRODUCTION_ACTIVATION.md", "utf8"),
    readFile("scripts/cloudflare-ui-rollout-shared.mjs", "utf8"),
  ]);

  assert.match(gate, /mode: "plan"/);
  assert.match(gate, /out\.mode !== "plan" && out\.mode !== "apply"/);
  assert.match(gate, /assertRepo\(args\.sha\)/);
  assert.match(gate, /await assertCi\(args\.sha, args\.ci\)/);
  assert.match(gate, /OWNER_AUTHORIZATION_INVALID/);
  assert.match(gate, /WRITE_STARTED=YES/);
  assert.match(gate, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(gate, /NO_BLIND_RETRY_IF_STOP_AFTER_WRITE_STARTED=YES/);
  assert.match(gate, /POST_WRITE_STATE=RECONCILE_REQUIRED/);

  assert.match(gate, /PRAGMA table_info\(webhook_deliveries\)/);
  assert.match(gate, /SELECT COUNT\(\*\) AS count FROM webhook_deliveries/);
  assert.match(gate, /D1_READ_MUTATED/);
  assert.match(gate, /assertTargetQueuesAbsent/);
  assert.match(gate, /cfWrite\(apiToken, "\/queues", "POST"/);
  assert.match(gate, /--experimental-provision=false/);
  assert.match(gate, /--experimental-auto-create=false/);
  assert.match(gate, /--secrets-file/);
  assert.match(gate, /mode: 0o600/);
  assert.match(gate, /await cleanupSecretFile\(\)/);

  // Parent Access identity comes from the already-accepted application token audience,
  // not from the deprecated/legacy domain representation in the app inventory.
  assert.match(gate, /readAccessTokenApplicationAudience/);
  assert.match(gate, /exactParentAccessApplication/);
  assert.match(gate, /await assertProtectedHealth\(accessToken, "PLAN"\)/);
  assert.match(gate, /const audience = accessAudience\(accessToken, "PLAN"\)/);
  assert.match(gate, /PARENT_ACCESS_APP_AUD=/);
  assert.doesNotMatch(gate, /app\?\.domain === HOSTNAME/);
  assert.match(identity, /payload\?\.type !== "app"/);
  assert.match(identity, /audiences\.length !== 1/);
  assert.match(identity, /app\?\.aud === audience/);

  // Modern Access app targeting uses destinations. Public `type` may be omitted,
  // but an explicitly non-public destination must still fail the public filter.
  // Legacy domain remains a read-only fallback only when destinations are absent.
  assert.match(identity, /Array\.isArray\(destinations\) && destinations\.length > 0/);
  assert.match(identity, /destination\.type !== undefined && destination\.type !== "public"/);
  assert.match(identity, /typeof destination\.uri === "string"/);
  assert.match(identity, /const legacyDomain = normalizePublicUri\(app\?\.domain\)/);
  assert.match(gate, /destinations: \[\{ type: "public", uri: WEBHOOK_ACCESS_DOMAIN \}\]/);
  assert.match(gate, /exactWebhookAccessApplications/);
  assert.match(gate, /assertExactWebhookAccessApplication/);

  assert.match(gate, /Rozkalns Control GitHub webhook/);
  assert.match(shared, /export const HOSTNAME = "control\.rozkalns\.net"/);
  assert.match(gate, /const WEBHOOK_ACCESS_DOMAIN = `\$\{HOSTNAME\}\$\{WEBHOOK_PATH\}`/);
  assert.match(gate, /\/api\/github\/webhook/);
  assert.match(gate, /decision: "bypass"/);
  assert.match(gate, /include: \[\{ everyone: \{\} \}\]/);
  assert.match(gate, /assertPublicSignedPing/);
  assert.match(gate, /X-Hub-Signature-256/);
  assert.match(gate, /body\?\.status !== "PING"/);
  assert.match(gate, /GITHUB_APP_WEBHOOK_CONFIGURATION_REQUIRED=YES/);
  assert.match(gate, /GITHUB_PERMISSION_GROWTH=NO/);

  assert.match(wrangler, /"CONTROL_WEBHOOK_RUNTIME_ENABLED": "true"/);
  assert.match(wrangler, /"GITHUB_WEBHOOK_SECRET"/);
  assert.match(wrangler, /"RECONCILIATION_QUEUE"/);
  assert.match(wrangler, /"rozkalns-control-reconciliation-dlq"/);
  assert.doesNotMatch(wrangler, /BEGIN (?:RSA )?PRIVATE KEY|ghs_|test-webhook-secret/i);
  assert.doesNotMatch(gate, /BEGIN (?:RSA )?PRIVATE KEY|ghs_|test-webhook-secret/i);
  assert.doesNotMatch(identity, /BEGIN (?:RSA )?PRIVATE KEY|ghs_|test-webhook-secret/i);

  assert.match(runbook, /Application Audience|AUD/);
  assert.match(runbook, /destinations/);
  assert.match(runbook, /GitHub App/);
  assert.match(runbook, /same secret/i);
  assert.match(runbook, /check_run/);
  assert.match(runbook, /workflow_run/);
  assert.match(runbook, /no blind retry/i);
});
