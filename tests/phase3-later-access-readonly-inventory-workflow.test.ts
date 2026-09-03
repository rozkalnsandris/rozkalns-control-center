import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = ".github/workflows/phase3-later-access-readonly-inventory.yml";

async function source(): Promise<string> {
  return readFile(workflow, "utf8");
}

test("Later Access inventory is owner-bounded, main-only and least privilege", async () => {
  const text = await source();
  assert.match(text, /^name: Phase 3 Later Access read-only inventory$/m);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /issue_comment:\s*\n\s+types: \[created\]/);
  assert.match(text, /github\.event\.issue\.number == 278/);
  assert.match(text, /github\.event\.comment\.user\.id == 277435981/);
  assert.match(text, /github\.event\.comment\.body == '\/phase3-later-access-inventory'/);
  assert.match(text, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.match(text, /environment:\s*\n\s+name: production-readonly-reconcile\s*\n\s+deployment: false/);
  assert.match(text, /GITHUB_REF_NAME:-}" = "main"/);
  assert.match(text, /GITHUB_RUN_ATTEMPT:-}" = "1"/);
  assert.match(text, /cancel-in-progress: false/);
});

test("Access admin credential is dedicated and read-only scope is explicit", async () => {
  const text = await source();
  assert.match(text, /CLOUDFLARE_ACCESS_READ_TOKEN: \$\{\{ secrets\.CLOUDFLARE_ACCESS_READ_TOKEN \}\}/);
  assert.match(text, /MISSING_CLOUDFLARE_ACCESS_READ_TOKEN/);
  assert.match(text, /ACCESS_READ_SECRET_NAME=CLOUDFLARE_ACCESS_READ_TOKEN/);
  assert.match(text, /ACCESS_READ_REQUIRED_SCOPE=Access_Apps_and_Policies_Read/);
  assert.doesNotMatch(text, /CLOUDFLARE_WORKERS_READ_TOKEN|CLOUDFLARE_D1_READ_TOKEN/);
});

test("inventory uses only GET semantics for Access applications and policies", async () => {
  const text = await source();
  assert.match(text, /TARGET_HOST: control\.rozkalns\.net/);
  assert.match(text, /TARGET_PATH: \/api\/github\/later/);
  assert.match(text, /fetch_paginated '\/access\/apps'/);
  assert.match(text, /fetch_paginated "\/access\/apps\/\$\{app_id\}\/policies"/);
  assert.match(text, /api\.cloudflare\.com\/client\/v4\/accounts\/\$\{CF_ACCOUNT_ID\}\$\{path\}/);
  assert.doesNotMatch(text, /-X (?:POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(text, /--data(?:-raw|-binary)?\b|-d\s/);
  assert.doesNotMatch(text, /\/api\/github\/later"/);
  assert.match(text, /ACCESS_API_METHOD=GET/);
});

test("candidate matching covers host wildcards, path prefixes and specific-path evidence", async () => {
  const text = await source();
  assert.match(text, /targetHost = process\.env\.TARGET_HOST\.toLowerCase\(\)/);
  assert.match(text, /targetPath = process\.env\.TARGET_PATH\.replace/);
  assert.match(text, /wildcardSegmentMatches/);
  assert.match(text, /hostParts\.length !== targetHostParts\.length/);
  assert.match(text, /targetSegments\.length < patternSegments\.length/);
  assert.match(text, /patternSegments\.every/);
  assert.match(text, /candidates\.sort\(\(a, b\) => b\.domain\.length - a\.domain\.length/);
  assert.match(text, /NO_MATCHING_ACCESS_APPLICATION/);
  assert.match(text, /ACCESS_APP_CANDIDATE_COUNT_UNBOUNDED/);
});

test("receipt exposes bounded app AUD and policy precedence without raw responses", async () => {
  const text = await source();
  for (const expected of [
    "MATCHING_ACCESS_APP_COUNT",
    "ACCESS_APP_%s_ID",
    "ACCESS_APP_%s_NAME",
    "ACCESS_APP_%s_TYPE",
    "ACCESS_APP_%s_DOMAIN",
    "ACCESS_APP_%s_AUD",
    "ACCESS_APP_%s_POLICY_COUNT",
    "ACCESS_APP_%s_POLICY_%s_ID",
    "ACCESS_APP_%s_POLICY_%s_NAME",
    "ACCESS_APP_%s_POLICY_%s_DECISION",
    "ACCESS_APP_%s_POLICY_%s_PRECEDENCE",
    "MATCHING_ACCESS_POLICY_TOTAL_COUNT",
  ]) assert.ok(text.includes(expected), `missing ${expected}`);

  assert.match(text, /sanitize_diag\(\)/);
  assert.match(text, /cut -c1-200/);
  assert.doesNotMatch(text, /cat\s+"?\$tmp\/(?:apps|policies)/);
  assert.doesNotMatch(text, /jq\s+['"]?\.['"]?\s+"?\$tmp\/(?:apps|policies)/);
});

test("workflow binds exact-main CI, anti-drift and no-mutation final gate", async () => {
  const text = await source();
  assert.match(text, /STAGE=GITHUB_EXACT_MAIN_CI/);
  assert.match(text, /\.path == "\.github\/workflows\/ci\.yml"/);
  assert.match(text, /\.event == "push"/);
  assert.match(text, /\.conclusion == "success"/);
  assert.match(text, /MAIN_SHA_DRIFT/);
  assert.match(text, /MAIN_SHA_FINAL_DRIFT/);
  assert.match(text, /ACCESS_INVENTORY=PASS/);
  assert.match(text, /CLOUDFLARE_ACCESS_MUTATION=NO/);
  assert.match(text, /LATER_POST_SENT=NO/);
  assert.match(text, /REMOTE_D1_MUTATION=NO/);
  assert.match(text, /WORKER_MUTATION=NO/);
  assert.match(text, /CLOUDFLARE_CONFIG_MUTATION=NO/);
  assert.match(text, /GITHUB_DECISION_MUTATION=NO/);
  assert.match(text, /NEXT_GATE=REVIEW_READONLY_ACCESS_APPLICATION_POLICY_INVENTORY/);
});
