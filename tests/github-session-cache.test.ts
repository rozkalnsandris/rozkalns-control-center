import assert from "node:assert/strict";
import test from "node:test";

import { parseGitHubInstallationReadScope } from "../src/integrations/github/app-installation-read-contract.js";
import { memoizeGitHubInstallationSessionProvider } from "../src/integrations/github/cloudflare-worker-runtime.js";

const scope = parseGitHubInstallationReadScope({
  installationId: 153121564,
  repositories: ["rozkalnsandris/hermes-tech"],
  permissions: {
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    checks: "read",
    actions: "read",
  },
});

test("request-scoped session memoization reuses one acquisition for the same exact scope and observation", async () => {
  let calls = 0;
  const acquire = memoizeGitHubInstallationSessionProvider(async () => {
    calls += 1;
    return { id: calls };
  });

  const first = await acquire(scope, "2026-08-14T18:10:00.000Z");
  const second = await acquire(scope, "2026-08-14T18:10:00.000Z");
  const later = await acquire(scope, "2026-08-14T18:10:01.000Z");

  assert.equal(calls, 2);
  assert.equal(first, second);
  assert.notEqual(first, later);
});

test("failed session acquisition is evicted so a later attempt can fail closed independently", async () => {
  let calls = 0;
  const acquire = memoizeGitHubInstallationSessionProvider(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary test failure");
    return { id: calls };
  });

  await assert.rejects(() => acquire(scope, "2026-08-14T18:10:00.000Z"));
  const recovered = await acquire(scope, "2026-08-14T18:10:00.000Z");

  assert.equal(calls, 2);
  assert.deepEqual(recovered, { id: 2 });
});
