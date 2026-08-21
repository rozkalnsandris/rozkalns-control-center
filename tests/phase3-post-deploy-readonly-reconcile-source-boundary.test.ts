import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/phase3-post-deploy-readonly-reconcile-255.yml"),
  "utf8",
);

test("Phase 3 production reconciliation stays manual, exact-baseline, and read-only", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /environment:\s*production-readonly-reconcile/);

  assert.match(workflow, /EXPECTED_NEW_VERSION:\s*f6dbb1c9-71d6-4665-b9b9-cb87dc99ccc7/);
  assert.match(workflow, /EXPECTED_NEW_DEPLOYMENT:\s*68041aea-8757-4c4e-8b29-b96902f03a00/);
  assert.match(workflow, /current_deployment.*EXPECTED_NEW_DEPLOYMENT/);
  assert.match(workflow, /current_version.*EXPECTED_NEW_VERSION/);
  assert.match(workflow, /ACTIVE_DEPLOYMENT_NOT_SINGLE_VERSION_100_PERCENT/);

  assert.match(workflow, /current_created_on=.*\| tostring \| @json \| \.\[0:160\]/);
  assert.match(workflow, /current_source=.*\| tostring \| @json \| \.\[0:160\]/);
  assert.match(workflow, /current_triggered_by=.*\.annotations\["workers\/triggered_by"\].*\| tostring \| @json \| \.\[0:160\]/);

  const diagnosticMarkers = [
    "OBSERVED_DEPLOYMENT_ID=%s\\n",
    "OBSERVED_VERSION_ID=%s\\n",
    "OBSERVED_TRAFFIC_PERCENT=%s\\n",
    "OBSERVED_DEPLOYMENT_CREATED_ON=%s\\n",
    "OBSERVED_DEPLOYMENT_SOURCE=%s\\n",
    "OBSERVED_DEPLOYMENT_TRIGGERED_BY=%s\\n",
  ];
  let previousDiagnosticIndex = -1;
  for (const marker of diagnosticMarkers) {
    const markerIndex = workflow.indexOf(marker);
    assert.ok(markerIndex > previousDiagnosticIndex, `${marker} must be present in reviewed order`);
    previousDiagnosticIndex = markerIndex;
  }

  const acceptedDeploymentGate = workflow.indexOf(
    '[ "$current_deployment" = "$EXPECTED_NEW_DEPLOYMENT" ] || stop ACTIVE_DEPLOYMENT_NOT_ACCEPTED_DEPLOYMENT',
  );
  assert.ok(
    acceptedDeploymentGate > previousDiagnosticIndex,
    "sanitized observed deployment evidence must be emitted before accepted-baseline comparison",
  );

  assert.match(workflow, /MAIN_SHA_DRIFT/);
  assert.match(workflow, /event=push&branch=main&head_sha=\$\{run_sha\}/);
  assert.match(workflow, /EXACT_MAIN_CI_NOT_SUCCESS/);
  assert.match(workflow, /EXACT_MAIN_CI_DRIFT/);

  assert.match(workflow, /access_get '\/api\/health'/);
  assert.match(workflow, /access_get '\/api\/github\/dashboard'/);
  assert.match(workflow, /\/api\/github\/needs-changes\/preflight\?/);
  assert.match(workflow, /NEEDS_CHANGES_POST=NOT_CALLED/);
  assert.match(workflow, /CLOUDFLARE_MUTATION=NO/);

  assert.doesNotMatch(workflow, /OBSERVED_[A-Z_]*AUTHOR/i);
  assert.doesNotMatch(
    workflow,
    /printf[^\n]*(?:CLOUDFLARE_API_TOKEN|CONTROL_ACCESS_CLIENT_ID|CONTROL_ACCESS_CLIENT_SECRET)/,
  );
  assert.doesNotMatch(workflow, /cat\s+["']?\$tmp\/deployments\.json/);
  assert.doesNotMatch(workflow, /wrangler\s+deploy/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /(?:^|\s)--request\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /access_(?:post|put|patch|delete)\s*\(/i);
});
