import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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

function signature(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

const githubVector = {
  secret: "It's a Secret to Everybody",
  payload: "Hello, World!",
  signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
};

const repositoryWebhook = {
  secret: "repository-webhook-secret",
  payload: JSON.stringify({ repository: { full_name: "rozkalnsandris/hermes-deals" } }),
};

const validWebhookHeaders = headers({
  "x-hub-signature-256": signature(repositoryWebhook.payload, repositoryWebhook.secret),
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

test("verified webhook repository is derived from the authenticated payload and cannot be swapped afterward", async () => {
  const webhook = await authenticateGitHubWebhook(
    repositoryWebhook.payload,
    validWebhookHeaders,
    repositoryWebhook.secret,
  );
  assert.equal(webhook.repository, "rozkalnsandris/hermes-deals");

  const tamperedPayload = JSON.stringify({ repository: { full_name: "rozkalnsandris/hermes-tech" } });
  await assert.rejects(
    () => authenticateGitHubWebhook(tamperedPayload, validWebhookHeaders, repositoryWebhook.secret),
    InvalidWebhookError,
  );

  const missingRepositoryPayload = JSON.stringify({ action: "opened" });
  await assert.rejects(
    () =>
      authenticateGitHubWebhook(
        missingRepositoryPayload,
        headers({
          "x-hub-signature-256": signature(missingRepositoryPayload, repositoryWebhook.secret),
          "x-github-delivery": "delivery-missing-repo",
          "x-github-event": "pull_request",
        }),
        repositoryWebhook.secret,
      ),
    InvalidWebhookError,
  );
});

test("verified deliveries are claimed once and always require an authoritative reread", async () => {
  const webhook = await authenticateGitHubWebhook(
    repositoryWebhook.payload,
    validWebhookHeaders,
    repositoryWebhook.secret,
  );
  const store = new InMemoryDeliveryClaimStore();

  const trigger = await createGitHubReconciliationTrigger(webhook, "2026-08-10T10:00:00Z", store);

  assert.equal(trigger.projectId, "hermes-deals");
  assert.equal(trigger.repository, "rozkalnsandris/hermes-deals");
  assert.equal(trigger.authoritativeReadRequired, true);

  await assert.rejects(
    () => createGitHubReconciliationTrigger(webhook, "2026-08-10T10:00:01Z", store),
    DuplicateDeliveryError,
  );

  const unknownPayload = JSON.stringify({ repository: { full_name: "someone/unknown" } });
  const secondWebhook = await authenticateGitHubWebhook(
    unknownPayload,
    headers({
      "x-hub-signature-256": signature(unknownPayload, repositoryWebhook.secret),
      "x-github-delivery": "delivery-unknown-repo",
      "x-github-event": "pull_request",
    }),
    repositoryWebhook.secret,
  );

  await assert.rejects(
    () => createGitHubReconciliationTrigger(secondWebhook, "2026-08-10T10:00:02Z", store),
    RepositoryNotAllowedError,
  );
});

test("authoritative PR snapshot binds merge, check, commit-status and workflow evidence to the observed head SHA", async () => {
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
    async getPullRequestMergeState() {
      return {
        pullNumber: 42,
        headSha,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        draft: false,
      };
    },
    async listPullRequestReviews() {
      return [{ id: "review-1", state: "APPROVED", actor: "reviewer", submittedAt: "2026-08-10T09:59:00Z" }];
    },
    async listCheckRuns() {
      return [{ id: "check-1", name: "CI", status: "completed", conclusion: "success", headSha, appId: 15368, detailsUrl: null }];
    },
    async listCommitStatuses() {
      return [{ id: "status-1", context: "legacy-ci", state: "success", headSha, targetUrl: null, createdAt: "2026-08-10T09:58:00Z" }];
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
  assert.equal(snapshot.mergeState.headSha, headSha);
  assert.equal(snapshot.mergeState.mergeStateStatus, "CLEAN");
  assert.equal(snapshot.mainSha, mainSha);
  assert.equal(snapshot.checkRuns[0]?.headSha, headSha);
  assert.equal(snapshot.checkRuns[0]?.appId, 15368);
  assert.equal(snapshot.commitStatuses[0]?.headSha, headSha);

  const staleCheckProvider: SourceControlReadProvider = {
    ...provider,
    async listCheckRuns() {
      return [{ id: "check-stale", name: "CI", status: "completed", conclusion: "success", headSha: "3".repeat(40), appId: null, detailsUrl: null }];
    },
  };

  await assert.rejects(
    () =>
      readAuthoritativePullRequestSnapshot(
        staleCheckProvider,
        "rozkalnsandris/hermes-deals",
        42,
        "2026-08-10T10:02:00Z",
      ),
    /does not match the observed pull-request head SHA/,
  );

  const staleStatusProvider: SourceControlReadProvider = {
    ...provider,
    async listCommitStatuses() {
      return [{ id: "status-stale", context: "legacy-ci", state: "success", headSha: "4".repeat(40), targetUrl: null, createdAt: "2026-08-10T09:58:00Z" }];
    },
  };

  await assert.rejects(
    () =>
      readAuthoritativePullRequestSnapshot(
        staleStatusProvider,
        "rozkalnsandris/hermes-deals",
        42,
        "2026-08-10T10:02:30Z",
      ),
    /Commit-status evidence does not match the observed pull-request head SHA/,
  );

  const staleMergeProvider: SourceControlReadProvider = {
    ...provider,
    async getPullRequestMergeState() {
      return {
        pullNumber: 42,
        headSha: "5".repeat(40),
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        draft: false,
      };
    },
  };

  await assert.rejects(
    () =>
      readAuthoritativePullRequestSnapshot(
        staleMergeProvider,
        "rozkalnsandris/hermes-deals",
        42,
        "2026-08-10T10:03:00Z",
      ),
    /Merge-state evidence does not match the observed pull-request head SHA/,
  );
});
