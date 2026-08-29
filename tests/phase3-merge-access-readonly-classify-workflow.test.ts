import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPath = ".github/workflows/phase3-merge-access-readonly-classify.yml";
const source = readFileSync(workflowPath, "utf8");

test("Merge Access classifier is owner-triggered and read-only", () => {
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /issue_comment:\s*\n\s+types: \[created\]/);
  assert.match(source, /github\.event\.issue\.number == 278/);
  assert.match(source, /github\.event\.issue\.pull_request == null/);
  assert.match(source, /github\.event\.comment\.user\.id == 277435981/);
  assert.match(source, /github\.event\.comment\.user\.type == 'User'/);
  assert.match(source, /github\.event\.comment\.body == '\/phase3-merge-access-classify'/);
  assert.match(source, /\.comment\.body == "\/phase3-merge-access-classify"/);

  assert.match(source, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.doesNotMatch(source, /contents: write|actions: write|issues: write|pull-requests: write/);
  assert.match(source, /name: production-readonly-reconcile/);
  assert.match(source, /deployment: false/);
});

test("Merge Access classifier proves exact main CI and stable 100% Worker deployment", () => {
  assert.match(source, /GITHUB_REF_NAME:-.*main/);
  assert.match(source, /event=push&branch=main&head_sha=\$\{run_sha\}/);
  assert.match(source, /conclusion == "success"/);
  assert.match(source, /\.commit\.sha == \$sha/);
  assert.match(source, /cf_workers_get "\/workers\/scripts\/\$\{WORKER_NAME\}\/deployments"/);
  assert.match(source, /\.result\.deployments\[0\]\.versions \| length == 1/);
  assert.match(source, /\.percentage == 100/);
  assert.match(source, /PRODUCTION_WORKER_FINAL_DRIFT/);

  const antiDriftIndex = source.indexOf("STAGE=FINAL_ANTI_DRIFT");
  const classifiedStopIndex = source.indexOf('if [ -n "$classified_stop" ]');
  assert.ok(antiDriftIndex >= 0);
  assert.ok(classifiedStopIndex > antiDriftIndex);
});

test("Merge Access classifier performs one bounded GET and has no D1 or mutation path", () => {
  assert.match(source, /HOSTNAME: control\.rozkalns\.net/);
  assert.match(source, /CONTROL_ACCESS_CLIENT_ID: \$\{\{ secrets\.CONTROL_ACCESS_CLIENT_ID \}\}/);
  assert.match(source, /CONTROL_ACCESS_CLIENT_SECRET: \$\{\{ secrets\.CONTROL_ACCESS_CLIENT_SECRET \}\}/);
  assert.match(source, /ACCESS_CREDENTIALS_SOURCE=ENVIRONMENT_SECRET_BINDINGS/);

  assert.equal((source.match(/\/api\/github\/merge/g) ?? []).length, 1);
  assert.match(source, /--max-filesize 65536/);
  assert.match(source, /-w '%\{http_code\}\\n%\{content_type\}\\n'/);
  assert.match(source, /CF-Access-Client-Id/);
  assert.match(source, /CF-Access-Client-Secret/);

  assert.doesNotMatch(source, /-X\s+POST|--request\s+POST/i);
  assert.doesNotMatch(source, /CLOUDFLARE_D1_READ_TOKEN|\/d1\/database\//i);
  assert.doesNotMatch(source, /wrangler\s+(deploy|versions\s+upload|versions\s+deploy|d1\s+migrations\s+apply)/i);
  assert.doesNotMatch(source, /gh\s+(pr\s+merge|run\s+rerun|run\s+cancel)/i);

  assert.match(source, /ACCESS_REQUEST_METHOD=GET/);
  assert.match(source, /ACCESS_MUTATION=NO/);
  assert.match(source, /MERGE_POST_SENT=NO/);
  assert.match(source, /WORKER_MUTATION=NO/);
  assert.match(source, /CLOUDFLARE_CONFIG_MUTATION=NO/);
  assert.match(source, /GITHUB_DECISION_MUTATION=NO/);
  assert.match(source, /GITHUB_APP_PERMISSION_MUTATION=NO/);
});

test("Merge Access classifier emits only bounded response metadata and whitelisted codes", () => {
  assert.match(source, /wc -c < "\$tmp\/access\.body"/);
  assert.match(source, /sha256sum "\$tmp\/access\.body"/);
  assert.match(source, /ACCESS_403_BODY_BYTES=/);
  assert.match(source, /ACCESS_403_BODY_SHA256=/);
  assert.match(source, /ACCESS_403_BODY_CLASS=/);
  assert.match(source, /application\/json\*/);
  assert.match(source, /text\/html\*/);
  assert.match(source, /\^\[A-Z0-9_\]\{1,80\}\$/);
  assert.match(source, /ACCESS_403_ERROR_CODE=/);
  assert.match(source, /ACCESS_403_DIAGNOSTIC_CODE=/);

  assert.doesNotMatch(source, /\bcat\s+[^\n]*access\.body/);
  assert.doesNotMatch(source, /\bhead\s+[^\n]*access\.body/);
  assert.doesNotMatch(source, /\btail\s+[^\n]*access\.body/);
  assert.doesNotMatch(source, /--dump-header|-D\s+[^\n]*/);
  assert.doesNotMatch(source, /printf[^\n]*(CONTROL_ACCESS_CLIENT_ID|CONTROL_ACCESS_CLIENT_SECRET)/);
});

test("Merge Access classifier separates edge-like and Worker auth 403 classes", () => {
  assert.match(source, /ACCESS_AUTHENTICATION_FAILED/);
  assert.match(source, /ACCESS_JWT_AUDIENCE_INVALID/);
  assert.match(source, /\.audience\.shape == "ARRAY"/);
  assert.match(source, /\.audience\.count <= 32/);
  assert.match(source, /\.audience\.sha256 \| length >= 1 and length <= 4/);
  assert.match(source, /OBSERVED_ACCESS_AUD_SHA256=/);

  assert.match(source, /ACCESS_403_ORIGIN_CLASS=WORKER_AUDIENCE_DIAGNOSTIC/);
  assert.match(source, /ACCESS_403_ORIGIN_CLASS=WORKER_AUTH_DIAGNOSTIC/);
  assert.match(source, /ACCESS_403_ORIGIN_CLASS=WORKER_AUTH_GENERIC/);
  assert.match(source, /ACCESS_403_ORIGIN_CLASS=JSON_OTHER/);
  assert.match(source, /ACCESS_403_ORIGIN_CLASS=EDGE_OR_HTML/);
  assert.match(source, /ACCESS_403_ORIGIN_CLASS=NON_JSON_OTHER/);

  assert.match(source, /MERGE_ACCESS_CLASSIFIED_WORKER_AUDIENCE_INVALID/);
  assert.match(source, /MERGE_ACCESS_CLASSIFIED_WORKER_AUTH_OTHER/);
  assert.match(source, /MERGE_ACCESS_CLASSIFIED_WORKER_AUTH_GENERIC/);
  assert.match(source, /MERGE_ACCESS_CLASSIFIED_JSON_403_OTHER/);
  assert.match(source, /MERGE_ACCESS_CLASSIFIED_EDGE_OR_HTML_403/);
  assert.match(source, /MERGE_ACCESS_CLASSIFIED_NON_JSON_403_OTHER/);
});
