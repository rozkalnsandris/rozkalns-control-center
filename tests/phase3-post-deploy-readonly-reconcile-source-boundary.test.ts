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

  assert.ok(workflow.includes('headers="${out}.headers"'));
  assert.ok(workflow.includes('-D "$headers" -o "$out" -w \'%{http_code}\''));
  assert.ok(workflow.includes("access_header_value 'cf-ray' \"$headers\""));
  assert.ok(workflow.includes("access_header_value 'server' \"$headers\""));
  assert.ok(workflow.includes("access_header_value 'content-type' \"$headers\""));
  assert.ok(workflow.includes("access_header_value 'cf-mitigated' \"$headers\""));
  assert.ok(workflow.includes("tr -cd '[:print:]' | cut -c1-160"));
  assert.match(workflow, /wc -c < "\$out"/);

  const accessDiagnosticMarkers = [
    "ACCESS_OBSERVED_HTTP_STATUS=%s\\n",
    "ACCESS_OBSERVED_CF_RAY=%s\\n",
    "ACCESS_OBSERVED_SERVER=%s\\n",
    "ACCESS_OBSERVED_CONTENT_TYPE=%s\\n",
    "ACCESS_OBSERVED_CF_MITIGATED=%s\\n",
    "ACCESS_OBSERVED_BODY_BYTES=%s\\n",
  ];
  let previousAccessDiagnosticIndex = -1;
  for (const marker of accessDiagnosticMarkers) {
    const markerIndex = workflow.indexOf(marker);
    assert.ok(markerIndex > previousAccessDiagnosticIndex, `${marker} must be present in reviewed order`);
    previousAccessDiagnosticIndex = markerIndex;
  }

  const emitAccessDiagnostics = workflow.indexOf(
    'emit_access_diagnostics "$status" "$headers" "$out"',
  );
  const accessHttpStop = workflow.indexOf('stop "ACCESS_HTTP_${status}"');
  assert.ok(emitAccessDiagnostics >= 0, "non-200 Access responses must emit bounded diagnostics");
  assert.ok(
    accessHttpStop > emitAccessDiagnostics,
    "bounded Access diagnostics must be emitted before fail-closed HTTP STOP",
  );

  assert.match(workflow, /NEEDS_CHANGES_POST=NOT_CALLED/);
  assert.match(workflow, /CLOUDFLARE_MUTATION=NO/);

  assert.doesNotMatch(workflow, /OBSERVED_[A-Z_]*AUTHOR/i);
  assert.doesNotMatch(
    workflow,
    /printf[^\n]*(?:CLOUDFLARE_API_TOKEN|CONTROL_ACCESS_CLIENT_ID|CONTROL_ACCESS_CLIENT_SECRET)/,
  );
  assert.doesNotMatch(workflow, /ACCESS_OBSERVED_(?:LOCATION|COOKIE|SET_COOKIE)/);
  assert.doesNotMatch(workflow, /access_header_value\s+['"](?:location|cookie|set-cookie)['"]/i);
  assert.doesNotMatch(workflow, /cat\s+["']?\$out/);
  assert.doesNotMatch(workflow, /cat\s+["']?\$headers/);
  assert.doesNotMatch(workflow, /cat\s+["']?\$tmp\/deployments\.json/);
  assert.doesNotMatch(workflow, /wrangler\s+deploy/);
  assert.doesNotMatch(workflow, /(?:^|\s)-X\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /(?:^|\s)--request\s+(?:POST|PUT|PATCH|DELETE)\b/m);
  assert.doesNotMatch(workflow, /access_(?:post|put|patch|delete)\s*\(/i);
});
