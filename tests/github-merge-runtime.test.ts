import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudflareMergeRuntime,
  resolveCloudflareMergeRuntime,
  type CloudflareMergeProductionBindings,
} from "../src/worker/github-merge-runtime.js";
import { RepositoryMergeNotAllowedError } from "../src/shared/project-policy.js";
import type { D1DatabaseLike } from "../src/integrations/cloudflare/d1-delivery-claim-store.js";
import type { GitHubAppCredentialFetch } from "../src/integrations/github/app-installation-session.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const HEAD = "1111111111111111111111111111111111111111";
const MAIN = "2222222222222222222222222222222222222222";

function createDatabase(state: { prepares: number }): D1DatabaseLike {
  return {
    prepare() {
      state.prepares += 1;
      throw new Error("D1 must not be reached while Merge capability is false");
    },
  };
}

function productionBindings(state: { prepares: number }): CloudflareMergeProductionBindings {
  return {
    GITHUB_APP_PRIVATE_KEY_PEM: "test-private-key-placeholder",
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_INSTALLATION_ID: "153121564",
    CONTROL_DB: createDatabase(state),
    CONTROL_MERGE_ACCESS_ISSUER: "https://test-team.cloudflareaccess.com",
    CONTROL_MERGE_ACCESS_AUDIENCE: "test-access-audience",
  };
}

test("Merge runtime denies current capability-false project before authoritative read, D1 or GitHub credential traffic", async () => {
  const state = { prepares: 0, githubFetches: 0 };
  const githubFetch: GitHubAppCredentialFetch = async () => {
    state.githubFetches += 1;
    throw new Error("GitHub must not be reached while Merge capability is false");
  };

  const runtime = createCloudflareMergeRuntime({
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
    clock: () => new Date("2026-08-24T13:45:00.000Z"),
  });

  await assert.rejects(
    runtime.executeDecision({
      requestId: "request_395_00002",
      actor: { subject: "verified-subject", email: null },
      repository: REPOSITORY,
      issueNumber: 47,
      pullNumber: 48,
      expectedHeadSha: HEAD,
      expectedMainSha: MAIN,
      mergeMethod: "squash",
    }),
    RepositoryMergeNotAllowedError,
  );

  assert.equal(state.prepares, 0);
  assert.equal(state.githubFetches, 0);
});

test("detached Merge production runtime resolver fails closed on missing or malformed Access bindings", () => {
  const state = { prepares: 0 };
  const valid = productionBindings(state);

  assert.equal(
    resolveCloudflareMergeRuntime({
      ...valid,
      CONTROL_MERGE_ACCESS_ISSUER: "http://test-team.cloudflareaccess.com",
    }),
    null,
  );
  assert.equal(
    resolveCloudflareMergeRuntime({
      ...valid,
      CONTROL_MERGE_ACCESS_AUDIENCE: "",
    }),
    null,
  );
  assert.equal(
    resolveCloudflareMergeRuntime({
      ...valid,
      CONTROL_MERGE_ACCESS_ISSUER: "https://test-team.cloudflareaccess.com/path",
    }),
    null,
  );
  assert.equal(state.prepares, 0);
});
