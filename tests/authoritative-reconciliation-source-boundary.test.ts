import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const SOURCE = "src/shared/authoritative-reconciliation.ts";
const WORKER = "src/worker/index.ts";

test("authoritative reconciliation remains source-only and permission-neutral", async () => {
  const [source, worker] = await Promise.all([
    readFile(SOURCE, "utf8"),
    readFile(WORKER, "utf8"),
  ]);

  for (const forbidden of [
    "fetch(",
    "Authorization",
    "Bearer ",
    "api.github.com",
    "privateKey",
    "private_key",
    "webhookSecret",
    "wrangler",
    "GitHubInstallationReadScope",
    "createGitHubReadRequest",
    "merge_pull_request",
    "Administration: read",
    "administration",
    "env.",
  ]) {
    assert.equal(source.includes(forbidden), false, `source-only composition must not contain ${forbidden}`);
  }

  assert.equal(source.includes("SourceControlReadProvider"), true);
  assert.equal(source.includes("BranchPolicyEvidenceReader"), true);
  assert.equal(source.includes("readAuthoritativePullRequestSnapshot"), true);
  assert.equal(source.includes("deriveProjectionPolicies"), true);
  assert.equal(source.includes("projectAuthoritativeSnapshotToDecision"), true);

  assert.equal(worker.includes("authoritative-reconciliation"), false);
  assert.equal(worker.includes("reconcileAuthoritativePullRequestDecision"), false);
});
