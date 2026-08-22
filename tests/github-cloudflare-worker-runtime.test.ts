import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  CloudflareGitHubRuntimeError,
  createCloudflareGitHubAppJwtSigner,
  createCloudflareGitHubReadRuntime,
  type CloudflareGitHubRuntimeBindings,
} from "../src/integrations/github/cloudflare-worker-runtime.js";

function rsaFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

function bindings(privateKeyPem: string): CloudflareGitHubRuntimeBindings {
  return {
    GITHUB_APP_PRIVATE_KEY_PEM: privateKeyPem,
    GITHUB_APP_CLIENT_ID: "Iv23likDoFtVeWBJfdFS",
    GITHUB_APP_INSTALLATION_ID: "153121564",
  };
}

function runtimeError(code: CloudflareGitHubRuntimeError["code"]) {
  return (error: unknown) => error instanceof CloudflareGitHubRuntimeError && error.code === code;
}

test("Cloudflare signer produces an RS256-compatible RSA/SHA-256 signature", async () => {
  const fixture = rsaFixture();
  const signer = createCloudflareGitHubAppJwtSigner(fixture.privateKeyPem);
  const input = new TextEncoder().encode("header.payload");

  const signature = await signer.signRs256(input);

  assert.equal(verify("sha256", input, fixture.publicKey, signature), true);
});

test("Cloudflare signer fails closed for missing or unusable private-key material", async () => {
  assert.throws(() => createCloudflareGitHubAppJwtSigner("   "), runtimeError("INVALID_BINDING"));

  const signer = createCloudflareGitHubAppJwtSigner("not-a-private-key");
  await assert.rejects(() => signer.signRs256(new TextEncoder().encode("header.payload")), runtimeError("SIGNING_FAILED"));
});

test("Cloudflare runtime validates non-secret identity bindings and creates an exact one-repository read scope", () => {
  const fixture = rsaFixture();
  let fetchCount = 0;
  const runtime = createCloudflareGitHubReadRuntime({
    bindings: bindings(fixture.privateKeyPem),
    fetchRequest: async () => {
      fetchCount += 1;
      throw new Error("network must not run while constructing the runtime context");
    },
  });

  const context = runtime.createRepositoryReadContext("rozkalnsandris/hermes-tech", "2026-08-13T00:00:00.000Z");

  assert.equal(runtime.clientId, "Iv23likDoFtVeWBJfdFS");
  assert.equal(runtime.installationId, 153121564);
  assert.deepEqual(context.scope.repositories, ["rozkalnsandris/hermes-tech"]);
  assert.deepEqual(context.scope.permissions, {
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    checks: "read",
    actions: "read",
  });
  assert.equal("statuses" in context.scope.permissions, false);
  assert.equal(fetchCount, 0);
});

test("Needs-changes runtime keeps normal reads unchanged and narrows classic and absence tokens to metadata baselines", () => {
  const fixture = rsaFixture();
  let fetchCount = 0;
  const runtime = createCloudflareGitHubReadRuntime({
    bindings: bindings(fixture.privateKeyPem),
    fetchRequest: async () => {
      fetchCount += 1;
      throw new Error("network must not run while constructing the Needs-changes context");
    },
  });

  const context = runtime.createRepositoryNeedsChangesReadContext(
    "rozkalnsandris/ops-workflows",
    "2026-08-22T17:30:25.000Z",
  );

  assert.deepEqual(context.scope.repositories, ["rozkalnsandris/ops-workflows"]);
  assert.deepEqual(context.scope.permissions, {
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    checks: "read",
    actions: "read",
  });
  assert.equal("administration" in context.scope.permissions, false);

  assert.deepEqual(context.classicScope.repositories, ["rozkalnsandris/ops-workflows"]);
  assert.deepEqual(context.classicScope.permissions, {
    metadata: "read",
    administration: "read",
  });

  assert.deepEqual(context.branchMetadataScope.repositories, ["rozkalnsandris/ops-workflows"]);
  assert.deepEqual(context.branchMetadataScope.permissions, {
    metadata: "read",
    contents: "read",
  });
  assert.equal(fetchCount, 0);
});

test("Cloudflare runtime rejects unselected repositories and inconsistent reconciliation context before network access", async () => {
  const fixture = rsaFixture();
  let fetchCount = 0;
  const runtime = createCloudflareGitHubReadRuntime({
    bindings: bindings(fixture.privateKeyPem),
    fetchRequest: async () => {
      fetchCount += 1;
      throw new Error("network must not run for rejected context");
    },
  });

  assert.throws(
    () => runtime.createRepositoryReadContext("rozkalnsandris/hermes-email-skill", "2026-08-13T00:00:00.000Z"),
    runtimeError("INVALID_REPOSITORY"),
  );
  assert.throws(
    () => runtime.createRepositoryReadContext("rozkalnsandris/hermes-tech", "not-a-time"),
    runtimeError("INVALID_CONTEXT"),
  );

  const context = runtime.createRepositoryReadContext("rozkalnsandris/hermes-tech", "2026-08-13T00:00:00.000Z");
  await assert.rejects(
    () => context.branchPolicyReader.readBranchPolicyEvidence(
      "rozkalnsandris/hermes-tech",
      "main",
      "2026-08-13T00:00:01.000Z",
    ),
    runtimeError("INVALID_CONTEXT"),
  );
  await assert.rejects(
    () => context.branchPolicyReader.readBranchPolicyEvidence(
      "rozkalnsandris/hermes-deals",
      "main",
      "2026-08-13T00:00:00.000Z",
    ),
    runtimeError("INVALID_CONTEXT"),
  );
  assert.equal(fetchCount, 0);
});

test("Cloudflare runtime rejects malformed client and installation bindings", () => {
  const fixture = rsaFixture();

  assert.throws(
    () => createCloudflareGitHubReadRuntime({
      bindings: { ...bindings(fixture.privateKeyPem), GITHUB_APP_CLIENT_ID: "bad\nclient" },
    }),
    runtimeError("INVALID_BINDING"),
  );
  assert.throws(
    () => createCloudflareGitHubReadRuntime({
      bindings: { ...bindings(fixture.privateKeyPem), GITHUB_APP_INSTALLATION_ID: "0" },
    }),
    runtimeError("INVALID_BINDING"),
  );
});
