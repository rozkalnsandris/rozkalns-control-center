import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  CloudflareGitHubRuntimeError,
  createCloudflareGitHubReadRuntime,
} from "../src/integrations/github/cloudflare-worker-runtime.js";

function runtime() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let fetchCount = 0;
  const readRuntime = createCloudflareGitHubReadRuntime({
    bindings: {
      GITHUB_APP_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_APP_CLIENT_ID: "Iv23likDoFtVeWBJfdFS",
      GITHUB_APP_INSTALLATION_ID: "153121564",
    },
    fetchRequest: async () => {
      fetchCount += 1;
      throw new Error("network must not run while constructing read contexts");
    },
  });
  return { readRuntime, fetchCount: () => fetchCount };
}

test("Needs changes isolates statuses and Administration reads from ordinary dashboard scope", () => {
  const fixture = runtime();
  const dashboard = fixture.readRuntime.createRepositoryReadContext(
    "rozkalnsandris/ops-workflows",
    "2026-08-17T18:20:00.000Z",
  );
  const needsChanges = fixture.readRuntime.createRepositoryNeedsChangesReadContext(
    "rozkalnsandris/ops-workflows",
    "2026-08-17T18:20:00.000Z",
  );

  assert.equal("administration" in dashboard.scope.permissions, false);
  assert.equal("statuses" in dashboard.scope.permissions, false);
  assert.equal("administration" in needsChanges.scope.permissions, false);
  assert.equal(needsChanges.scope.permissions.statuses, "read");
  assert.deepEqual(needsChanges.classicScope.repositories, ["rozkalnsandris/ops-workflows"]);
  assert.deepEqual(needsChanges.classicScope.permissions, {
    metadata: "read",
    administration: "read",
  });
  assert.deepEqual(needsChanges.branchMetadataScope.repositories, ["rozkalnsandris/ops-workflows"]);
  assert.deepEqual(needsChanges.branchMetadataScope.permissions, {
    metadata: "read",
    contents: "read",
  });
  assert.deepEqual(needsChanges.classicBranchProtectionReader.absenceScope.permissions, {
    metadata: "read",
    contents: "read",
  });
  assert.equal(fixture.fetchCount(), 0);
});

test("Needs changes combined policy context rejects repository and timestamp identity drift before network", async () => {
  const fixture = runtime();
  const context = fixture.readRuntime.createRepositoryNeedsChangesReadContext(
    "rozkalnsandris/ops-workflows",
    "2026-08-17T18:20:00.000Z",
  );

  await assert.rejects(
    () => context.branchPolicyReader.readBranchPolicyEvidence(
      "rozkalnsandris/hermes-tech",
      "main",
      "2026-08-17T18:20:00.000Z",
    ),
    (error: unknown) => error instanceof CloudflareGitHubRuntimeError && error.code === "INVALID_CONTEXT",
  );
  await assert.rejects(
    () => context.branchPolicyReader.readBranchPolicyEvidence(
      "rozkalnsandris/ops-workflows",
      "main",
      "2026-08-17T18:20:01.000Z",
    ),
    (error: unknown) => error instanceof CloudflareGitHubRuntimeError && error.code === "INVALID_CONTEXT",
  );
  assert.equal(fixture.fetchCount(), 0);
});
