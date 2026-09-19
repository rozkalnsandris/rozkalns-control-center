import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("owner action activation inventory passes focused read-only and schema regressions", () => {
  const result = spawnSync("python3", ["scripts/owner-panel-readonly-preflight.test.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("owner action inventory workflow is manual, read-only and has no rollout command", () => {
  const workflow = readFileSync(".github/workflows/owner-panel-readonly-preflight.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: production-readonly-reconcile/);

  const permissionsBlock = workflow.match(/^permissions:\n(?: {2}[^\n]+\n)+/m)?.[0] ?? "";
  assert.match(permissionsBlock, /contents: read/);
  assert.match(permissionsBlock, /actions: read/);
  assert.doesNotMatch(permissionsBlock, /\bwrite\b/);

  assert.doesNotMatch(workflow, /wrangler|workflow_call:|pull_request:|secrets-file|secret put|migrations apply/);
});
