import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseGitHubInstallationReadScope,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
  type GitHubReadResult,
} from "../src/integrations/github/app-installation-read-contract.js";
import { createGitHubActiveBranchRulesReader } from "../src/integrations/github/active-branch-rules-reader.js";

const repository = "rozkalnsandris/ops-workflows";
const observedAt = "2026-08-18T16:20:00.000Z";

function metadataScope(): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions: { metadata: "read" },
  });
}

function transport(payload: unknown): GitHubInstallationReadTransport {
  return {
    async get<T>(scope: GitHubInstallationReadScope): Promise<GitHubReadResult<T>> {
      return {
        pages: [[payload] as T],
        credentialLease: {
          installationId: scope.installationId,
          repositories: scope.repositories,
          permissions: scope.permissions,
          issuedAt: observedAt,
          expiresAt: "2026-08-18T17:15:00.000Z",
        },
        requestCount: 1,
        rateLimit: null,
      };
    },
  };
}

test("active reader retains raw rule cardinality even for rules not projected into CI/review policy", async () => {
  const scope = metadataScope();
  const reader = createGitHubActiveBranchRulesReader({
    scope,
    observedAt,
    restTransport: transport({ type: "non_fast_forward" }),
  });

  const observation = await reader.readActiveBranchRules(repository, "main");
  assert.equal(observation.activeRuleCount, 1);
  assert.deepEqual(observation.requiredStatusChecks, []);
  assert.equal(observation.requiredApprovals, 0);
});

test("runtime accepts classic absence only with zero active rules and keeps fallback scopes fixed/read-only", async () => {
  const [runtime, classic] = await Promise.all([
    readFile("src/integrations/github/cloudflare-worker-runtime.ts", "utf8"),
    readFile("src/integrations/github/classic-branch-protection-reader.ts", "utf8"),
  ]);

  assert.match(runtime, /permissions: \{ administration: "read" \}/);
  assert.match(runtime, /permissions: \{ contents: "read" \}/);
  assert.match(runtime, /classic\.classicProtectionState === "ABSENT" && active\.activeRuleCount !== 0/);
  assert.match(runtime, /throw new CloudflareGitHubRuntimeError\("INVALID_CONTEXT"\)/);

  assert.match(classic, /error instanceof GitHubRestReadError && error\.code === "NOT_FOUND" && error\.status === 404/);
  assert.match(classic, /`\/repos\/\$\{repository\}\/branches\/\$\{encodedBranch\}`/);
  assert.match(classic, /"contents"/);
  assert.doesNotMatch(classic, /Branch not protected/i);
  assert.doesNotMatch(classic, /\.message/);
  assert.doesNotMatch(classic, /\bPOST\b|\bPATCH\b|\bPUT\b|\bDELETE\b/);
});
