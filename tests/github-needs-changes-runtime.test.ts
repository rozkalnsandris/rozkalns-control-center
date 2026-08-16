import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createCloudflareNeedsChangesRuntime } from "../src/worker/github-needs-changes-runtime.js";
import { RepositoryNeedsChangesNotAllowedError } from "../src/shared/project-policy.js";
import type { D1DatabaseLike } from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import type { GitHubAppCredentialFetch } from "../src/integrations/github/app-installation-session.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const HEAD = "1111111111111111111111111111111111111111";
const MAIN = "2222222222222222222222222222222222222222";

function createDatabase(state: { prepares: number }): D1DatabaseLike {
  return {
    prepare() {
      state.prepares += 1;
      throw new Error("D1 must not be reached while capability is false");
    },
  };
}

test("runtime denies current capability-false project before D1 or GitHub credential traffic", async () => {
  const state = { prepares: 0, githubFetches: 0 };
  const githubFetch: GitHubAppCredentialFetch = async () => {
    state.githubFetches += 1;
    throw new Error("GitHub must not be reached while capability is false");
  };

  const runtime = createCloudflareNeedsChangesRuntime({
    bindings: {
      GITHUB_APP_PRIVATE_KEY_PEM: "test-private-key-placeholder",
      GITHUB_APP_CLIENT_ID: "test-client-id",
      GITHUB_APP_INSTALLATION_ID: "153121564",
      CONTROL_DB: createDatabase(state),
    },
    access: {
      issuer: "https://test-team.cloudflareaccess.com",
      audience: "test-access-audience",
    },
    githubFetch,
    accessFetch: async () => {
      throw new Error("Access JWKS is not needed for direct capability-denial test");
    },
    clock: () => new Date("2026-08-16T21:20:00.000Z"),
  });

  await assert.rejects(
    runtime.executeDecision({
      requestId: "request_221_00002",
      actor: { subject: "verified-subject", email: null },
      repository: REPOSITORY,
      issueNumber: 47,
      pullNumber: 48,
      expectedHeadSha: HEAD,
      expectedMainSha: MAIN,
      body: "Please address the reviewed issues.",
    }),
    RepositoryNeedsChangesNotAllowedError,
  );

  assert.equal(state.prepares, 0);
  assert.equal(state.githubFetches, 0);
});

test("source boundary keeps detached Needs changes runtime unreachable from production entrypoint", async () => {
  const [indexSource, wranglerSource, policySource] = await Promise.all([
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
    readFile("src/shared/project-policy.ts", "utf8"),
  ]);

  assert.equal(indexSource.includes("github-needs-changes-route"), false);
  assert.equal(indexSource.includes("github-needs-changes-runtime"), false);
  assert.equal(indexSource.includes("/api/github/needs-changes"), false);

  assert.equal(wranglerSource.includes("CONTROL_NEEDS_CHANGES"), false);
  assert.equal(wranglerSource.includes("CONTROL_ACCESS_ISSUER"), false);
  assert.equal(wranglerSource.includes("CONTROL_ACCESS_AUDIENCE"), false);
  assert.equal(wranglerSource.includes("pull_requests"), false);

  const capabilityAssignments = policySource.match(/canRequestChanges:\s*false/g) ?? [];
  assert.equal(capabilityAssignments.length, 6);
  assert.equal(policySource.includes("canRequestChanges: true"), false);
});
