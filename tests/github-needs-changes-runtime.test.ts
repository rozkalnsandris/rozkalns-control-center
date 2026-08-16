import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCloudflareNeedsChangesRuntime,
  resolveCloudflareNeedsChangesRuntime,
  type CloudflareNeedsChangesProductionBindings,
} from "../src/worker/github-needs-changes-runtime.js";
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

function productionBindings(state: { prepares: number }): CloudflareNeedsChangesProductionBindings {
  return {
    GITHUB_APP_PRIVATE_KEY_PEM: "test-private-key-placeholder",
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_INSTALLATION_ID: "153121564",
    CONTROL_DB: createDatabase(state),
    CONTROL_NEEDS_CHANGES_ACCESS_ISSUER: "https://test-team.cloudflareaccess.com",
    CONTROL_NEEDS_CHANGES_ACCESS_AUDIENCE: "test-access-audience",
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

test("production runtime resolver fails closed on missing or malformed Access identity bindings", () => {
  const state = { prepares: 0 };
  const valid = productionBindings(state);

  assert.equal(
    resolveCloudflareNeedsChangesRuntime({
      ...valid,
      CONTROL_NEEDS_CHANGES_ACCESS_ISSUER: "http://test-team.cloudflareaccess.com",
    }),
    null,
  );
  assert.equal(
    resolveCloudflareNeedsChangesRuntime({
      ...valid,
      CONTROL_NEEDS_CHANGES_ACCESS_AUDIENCE: "",
    }),
    null,
  );
  assert.equal(
    resolveCloudflareNeedsChangesRuntime({
      ...valid,
      CONTROL_NEEDS_CHANGES_ACCESS_ISSUER: "https://test-team.cloudflareaccess.com/path",
    }),
    null,
  );
  assert.equal(state.prepares, 0);
});

test("production entrypoint wires Needs changes while every managed capability remains off", async () => {
  const [indexSource, wranglerSource, policySource] = await Promise.all([
    readFile("src/worker/index.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
    readFile("src/shared/project-policy.ts", "utf8"),
  ]);

  assert.equal(indexSource.includes("github-needs-changes-route"), true);
  assert.equal(indexSource.includes("github-needs-changes-runtime"), true);
  assert.equal(indexSource.includes("GITHUB_NEEDS_CHANGES_ROUTE_PATH"), true);
  assert.equal(indexSource.includes("handleGitHubNeedsChangesRequest"), true);
  assert.equal(indexSource.includes("resolveCloudflareNeedsChangesRuntime"), true);

  assert.equal(wranglerSource.includes("CONTROL_NEEDS_CHANGES_ACCESS_ISSUER"), true);
  assert.equal(wranglerSource.includes("CONTROL_NEEDS_CHANGES_ACCESS_AUDIENCE"), true);
  assert.equal(wranglerSource.includes("https://super-salad-2357.cloudflareaccess.com"), true);
  assert.equal(
    wranglerSource.includes("c69850b0fcfeef951512b81941aec53e4e406c16e11d396ab0abe25f35728c75"),
    true,
  );
  assert.equal(wranglerSource.includes("CONTROL_ACCESS_AUTH_CANARY_ENABLED"), false);
  assert.equal(wranglerSource.includes("\"CONTROL_ACCESS_ISSUER\""), false);
  assert.equal(wranglerSource.includes("\"CONTROL_ACCESS_AUDIENCE\""), false);
  assert.equal(wranglerSource.includes("pull_requests"), false);

  const capabilityAssignments = policySource.match(/canRequestChanges:\s*false/g) ?? [];
  assert.equal(capabilityAssignments.length, 6);
  assert.equal(policySource.includes("canRequestChanges: true"), false);
});
