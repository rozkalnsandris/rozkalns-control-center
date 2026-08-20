import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/daily-mvp-production-preflight.yml"),
  "utf8",
);

test("Daily MVP production preflight is manual and read-only", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /environment:\s*production-readonly-reconcile/);

  assert.match(workflow, /GITHUB_EXACT_MAIN_CI/);
  assert.match(workflow, /event=push&branch=main&head_sha=\$\{run_sha\}/);
  assert.match(workflow, /\.conclusion == "success"/);
  assert.match(workflow, /MAIN_SHA_DRIFT/);

  assert.match(workflow, /EXPECTED_ACTIVE_VERSION:\s*a31c4318-9ff6-4a05-9748-c923c453262d/);
  assert.match(workflow, /EXPECTED_ACTIVE_DEPLOYMENT:\s*8e536678-a89d-4079-a8ef-92d3103dbcbf/);
  assert.match(workflow, /ACTIVE_DEPLOYMENT_REVERTED_TO_FROZEN_PRE_DEPLOYMENT/);
  assert.match(workflow, /ACTIVE_DEPLOYMENT_DRIFT/);
  assert.match(workflow, /ACTIVE_VERSION_DRIFT/);
  assert.match(workflow, /ACTIVE_DEPLOYMENT_NOT_SINGLE_VERSION_100_PERCENT/);
  assert.match(workflow, /VERSION_BINDING_IDENTITY_DRIFT/);
  assert.match(workflow, /CUSTOM_DOMAIN_IDENTITY_DRIFT/);

  assert.match(workflow, /ACCESS_RUNTIME_PROBE=NOT_PART_OF_DAILY_MVP_DEPLOY_GATE/);
  assert.match(workflow, /CLOUDFLARE_MUTATION=NO/);
  assert.match(workflow, /DEPLOY_STARTED=NO/);
  assert.match(workflow, /DEPLOY_AUTHORIZATION=NOT_GRANTED/);

  assert.doesNotMatch(workflow, /wrangler\s+deploy/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /(?:^|\s)--request\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /CONTROL_ACCESS_CLIENT_(?:ID|SECRET)/);
  assert.doesNotMatch(workflow, /\/api\/github\/needs-changes/);
  assert.doesNotMatch(workflow, /CONTROL_NOTIFICATION_TRANSITIONS_ENABLED/);
  assert.doesNotMatch(workflow, /CONTROL_NOTIFICATION_TARGET_KEYS/);
});
