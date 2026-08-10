import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateGitHubWebhook,
  InvalidWebhookError,
  readGitHubWebhookHeaders,
  verifyGitHubWebhookSignature,
  type HeaderReader,
} from "../src/shared/github-webhook.js";
import {
  createGitHubReconciliationTrigger,
  DuplicateDeliveryError,
  InMemoryDeliveryClaimStore,
} from "../src/shared/github-reconciliation.js";
import {
  explicitlyExcludedRepositories,
  isExplicitlyExcludedRepository,
  managedProjectPolicies,
  RepositoryNotAllowedError,
  requireManagedProjectPolicy,
} from "../src/shared/project-policy.js";
import {
  readAuthoritativePullRequestSnapshot,
  type SourceControlReadProvider,
} from "../src/shared/source-control-read.js";

function headers(values: Record<string, string>): HeaderReader {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => normalized.get(name.toLowerCase()) ?? null };
}

const githubVector = {
  secret: "It's a Secret to Everybody",
  payload: "Hello, World!",
  signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
};

const validWebhookHeaders = headers({
  "x-hub-signature-256": githubVector.signature,
  "x-github-delivery": "delivery-123",
  "x-github-event": "pull_request",
});

test("managed repository policy is allow-list driven and keeps hermes-email-skill excluded", () => {
  assert.equal(managedProjectPolicies.length, 6);
  assert.deepEqual(explicitlyExcludedRepositories, ["rozkalnsandris/hermes-email-skill"]);
  assert.equal(isExplicitlyExcludedRepository("rozkalnsandris/hermes-email-skill"), true);
  assert.equal(requireManagedProjectPolicy("ROZKALNSANDRIS/HERMES-DEALS").id, "hermes-deals");
  assert.throws(() => requireManagedProjectPolicy("rozkalnsandris/hermes-email-skill"), RepositoryNotAllowedError);
  assert.throws(() => requireManagedProjectPolicy("someone/unknown"), RepositoryNotAllowedError);
});

test("GitHub published webhook HMAC-SHA256 test vector verifies", async () => {
  assert.equal(
    await verifyGitHubWebhookSignature(githubVector.payload, githubVector.signature, githubVector.secret),
    true,
  );
  assert.equal(
    await verifyGitHubWebhookSignature(githubVector.payload, `sha256=${"0".repeat(64)}`, githubVector.secret),
    false,
  );
  assert.equal(await verifyGitHubWebhookSignature(githubVector.payload, "bad", githubVector.secret), false);
});

test("webhook header parsing fails closed on missing or malformed authentication metadata", () => {
  assert.throws(
    () => readGitHubWebhookHeaders(headers({ "x-github-delivery": "delivery-1", "x-github-event": "push" })),
    InvalidWebhookError,
  );
  assert.throws(
    () =>
      readGitHubWebhookHeaders(
        headers({
          "x-hub-signature-256": "sha256=not-hex",
          "x-github-delivery": "delivery-1",
          "x-github-event": "push",
        }),
      ),
    InvalidWebhookError,
  );
});

test("verified deliveries are claimed once and always require an authoritative reread", async () => {
  const webhook = await authenticateGitHubWebhook(githubVector.payload, validWebhookHeaders, githubVector.secret);
  const store = new InMemoryDeliveryClaimStore();

  const trigger = await createGitHubReconciliationTrigger(
    webhook,
    "rozkalnsandris/hermes-deals",
    "2026-08-10T10:00:00Z",
    store,
  );

  assert.equal(trigger.projectId, "hermes-deals");
  assert.equal(trigger.authoritativeReadRequired, true);

  await assert.rejects(
    () =>
      createGitHubReconciliationTrigger(
        webhook,
        "rozkalnsandris/hermes-deals",
        "2026-08-10T10:00:01Z",
        store,
      ),
    DuplicateDeliveryError,
  );

  const secondWebhook = await authenticateGitHubWebhook(
    githubVector.payload,
    headers({
      "x-hub-signature-256": githubVector.signature,
      "x-github-delivery": "delivery-unknown-repo",
      "x-github-event": "pull_request",
    }),
    githubVector.secret,
  );

  await assert.rejects(
    () => createGitHubReconciliationTrigger(secondWebhook, "someone/unknown", "2026-08-10T10:00:02Z", store),
    RepositoryNotAllowedError,
  );
});

test("authoritative PR snapshot binds checks and workflows to the observed head SHA", async () => {
  const headSha = "1".repeat(40);
  const mainSha = "2".repeat(40);

  const provider: SourceControlReadProvider = {
    async getRepository(repository) {
      return { repository, defaultBranch: "main" };
    },
    async getDefaultBranchHead() {
      return mainSha;
    },
    async listOpenIssues() {
      return [];
    },
    async listOpenPullRequests() {
      return [];
    },
    async getPullRequest() {
      return {
        number: 42,
        title: "Read-only fixture PR",
        state: "open",
        draft: false,
        baseRef: "main",
        baseSha: mainSha,
        headRef: "feature/read-only",
        headSha,
        changedFiles: 3,
        htmlUrl: "https://github.com/rozkalnsandris/hermes-deals/pull/42",
      };
    },
    async listPullRequestReviews() {
      return [{ id: "review-1", state: "APPROVED", actor: "reviewer", submittedAt: "2026-08-10T09:59:00Z" }];
    },
    async listCheckRuns() {
      return [{ id: "check-1", name: "CI", status: "completed", conclusion: "success", headSha, detailsUrl: null }];
    },
    async listWorkflowRuns() {
      return [{ id: "run-1", name: "CI", status: "completed", conclusion: "success", headSha, htmlUrl: "https://github.com/example/run" }];
    },
  };

  const snapshot = await readAuthoritativePullRequestSnapshot(
    provider,
    "rozkalnsandris/hermes-deals",
    42,
    "2026-08-10T10:01:00Z",
  );

  assert.equal(snapshot.authoritativeRead, true);
  assert.equal(snapshot.pullRequest.headSha, headSha);
  assert.equal(snapshot.mainSha, mainSha);
  assert.equal(snapshot.checkRuns[0]?.headSha, headSha);

  const staleProvider: SourceControlReadProvider = {
    ...provider,
    async listCheckRuns() {
      return [{ id: "check-stale", name: "CI", status: "completed", conclusion: "success", headSha: "3".repeat(40), detailsUrl: null }];
    },
  };

  await assert.rejects(
    () =>
      readAuthoritativePullRequestSnapshot(
        staleProvider,
        "rozkalnsandris/hermes-deals",
        42,
        "2026-08-10T10:02:00Z",
      ),
    /does not match the observed pull-request head SHA/,
  );
});
