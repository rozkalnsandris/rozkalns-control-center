import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseGitHubInstallationReadScope,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
  type GitHubReadRequest,
  type GitHubReadResult,
} from "../src/integrations/github/app-installation-read-contract.js";
import { createGitHubClassicBranchProtectionReader } from "../src/integrations/github/classic-branch-protection-reader.js";
import { GitHubRestReadError } from "../src/integrations/github/rest-read-transport.js";

const repository = "rozkalnsandris/ops-workflows";
const observedAt = "2026-08-26T00:20:00.000Z";

function scope(permissions: GitHubInstallationReadScope["permissions"]): GitHubInstallationReadScope {
  return parseGitHubInstallationReadScope({
    installationId: 153121564,
    repositories: [repository],
    permissions,
  });
}

function result<T>(readScope: GitHubInstallationReadScope, payload: T): GitHubReadResult<T> {
  return {
    pages: [payload],
    credentialLease: {
      installationId: readScope.installationId,
      repositories: readScope.repositories,
      permissions: readScope.permissions,
      issuedAt: observedAt,
      expiresAt: "2026-08-26T01:15:00.000Z",
    },
    requestCount: 1,
    rateLimit: null,
  };
}

test("classic 404 recognizes ruleset-only protected branch without inventing classic protection", async () => {
  const classicScope = scope({ metadata: "read", administration: "read" });
  const absenceScope = scope({ metadata: "read", contents: "read" });
  const calls: GitHubReadRequest[] = [];
  const restTransport: GitHubInstallationReadTransport = {
    async get<T>(readScope, request): Promise<GitHubReadResult<T>> {
      calls.push(request);
      if (request.path.endsWith("/protection")) {
        throw new GitHubRestReadError("NOT_FOUND", { status: 404 });
      }
      return result(readScope, {
        name: "main",
        protected: true,
        protection: { enabled: false },
      }) as GitHubReadResult<T>;
    },
  };

  const reader = createGitHubClassicBranchProtectionReader({
    scope: classicScope,
    absenceScope,
    observedAt,
    restTransport,
  });

  const observation = await reader.readClassicBranchProtection(repository, "main");

  assert.equal(observation.classicProtectionState, "ABSENT_RULESET_PROTECTED");
  assert.deepEqual(observation.requiredStatusChecks, []);
  assert.equal(observation.requiredApprovals, 0);
  assert.deepEqual(calls.map(({ path }) => path), [
    `/repos/${repository}/branches/main/protection`,
    `/repos/${repository}/branches/main`,
  ]);
});

test("Needs-changes runtime keeps absence/ruleset evidence consistency fail-closed", async () => {
  const runtime = await readFile("src/integrations/github/cloudflare-worker-runtime.ts", "utf8");

  assert.match(
    runtime,
    /classic\.classicProtectionState === "ABSENT" && active\.activeRuleCount !== 0/,
  );
  assert.match(
    runtime,
    /classic\.classicProtectionState === "ABSENT_RULESET_PROTECTED" && active\.activeRuleCount === 0/,
  );
});
