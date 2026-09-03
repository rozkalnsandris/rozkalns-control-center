import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("conditional REST reuse is limited to the read-only reconciliation route", async () => {
  const [route, provider, mergeRuntime, needsChangesRuntime, preflightRoute] = await Promise.all([
    readFile("src/worker/github-reconciliation-route.ts", "utf8"),
    readFile("src/integrations/github/authoritative-read-provider.ts", "utf8"),
    readFile("src/worker/github-merge-runtime.ts", "utf8"),
    readFile("src/worker/github-needs-changes-runtime.ts", "utf8"),
    readFile("src/worker/github-needs-changes-preflight-route.ts", "utf8"),
  ]);

  assert.match(route, /purpose: "READ_ONLY_CONDITIONAL"/);
  assert.match(route, /readOnlyReconciliationCache/);
  assert.match(provider, /restReadMode === "READ_ONLY_CONDITIONAL"/);
  for (const liveBoundary of [mergeRuntime, needsChangesRuntime, preflightRoute]) {
    assert.match(liveBoundary, /createRepositoryNeedsChangesReadContext/);
    assert.doesNotMatch(liveBoundary, /READ_ONLY_CONDITIONAL/);
  }
});

test("conditional cache identity includes installation, repository, permissions and exact query URL", async () => {
  const transport = await readFile("src/integrations/github/rest-read-transport.ts", "utf8");
  assert.match(
    transport,
    /scope\.installationId,[\s\S]*repositories,[\s\S]*permissions,[\s\S]*request\.repository\.toLowerCase\(\),[\s\S]*request\.requiredPermission,[\s\S]*url\.href/,
  );
  assert.match(transport, /GITHUB_REST_CONDITIONAL_CACHE_MAX_ENTRIES = 100/);
  assert.match(transport, /GITHUB_REST_CONDITIONAL_CACHE_MAX_BODY_BYTES = 1024 \* 1024/);
  assert.match(transport, /GITHUB_REST_CONDITIONAL_CACHE_MAX_TOTAL_BYTES = 5 \* 1024 \* 1024/);
});
