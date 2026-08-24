import assert from "node:assert/strict";
import test from "node:test";

import {
  executeMergeDecision,
  MergeDecisionError,
  type MergeAuditClaimInput,
  type MergeAuditClaimResult,
  type MergeAuditTerminalOutcome,
  type MergeDecisionAuditStore,
  type MergeDecisionRequest,
} from "../src/shared/merge-decision.js";
import type { BranchPolicyEvidenceReader } from "../src/shared/authoritative-reconciliation.js";
import type { BranchPolicyEvidence } from "../src/shared/github-policy-evidence.js";
import type {
  CheckRunRead,
  CommitStatusRead,
  IssueRead,
  PullRequestMergeStateRead,
  PullRequestRead,
  PullRequestReviewRead,
  RepositoryRef,
  SourceControlReadProvider,
  WorkflowRunRead,
} from "../src/shared/source-control-read.js";
import {
  GitHubPullRequestMergeWriteError,
  type GitHubMergePullRequestWriteRequest,
  type GitHubPullRequestMergeWriter,
} from "../src/integrations/github/pull-request-merge-write.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const ISSUE_NUMBER = 47;
const PULL_NUMBER = 48;
const HEAD = "1111111111111111111111111111111111111111";
const OTHER_HEAD = "3333333333333333333333333333333333333333";
const MAIN = "2222222222222222222222222222222222222222";
const OTHER_MAIN = "4444444444444444444444444444444444444444";
const MERGE_SHA = "5555555555555555555555555555555555555555";
const NOW = new Date("2026-08-24T12:50:00.000Z");
const REQUEST_ID = "merge_request_391_0001";

interface ProviderState {
  head: string;
  main: string;
  pullState: "open" | "closed";
  draft: boolean;
  checkConclusion: "success" | "failure";
  reviewState: "APPROVED" | "CHANGES_REQUESTED";
  readCalls: number;
}

function createProvider(overrides: Partial<ProviderState> = {}): {
  provider: SourceControlReadProvider;
  state: ProviderState;
} {
  const state: ProviderState = {
    head: HEAD,
    main: MAIN,
    pullState: "open",
    draft: false,
    checkConclusion: "success",
    reviewState: "APPROVED",
    readCalls: 0,
    ...overrides,
  };

  const repositoryRead = (): RepositoryRef => ({ repository: REPOSITORY, defaultBranch: "main" });
  const issue = (): IssueRead => ({
    number: ISSUE_NUMBER,
    title: "Guarded Merge decision",
    state: "open",
    htmlUrl: `https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
  });
  const pull = (): PullRequestRead => ({
    number: PULL_NUMBER,
    title: "Phase 3 guarded Merge boundary",
    state: state.pullState,
    draft: state.draft,
    baseRef: "main",
    baseSha: state.main,
    headRef: "feat/phase3-merge",
    headSha: state.head,
    changedFiles: 2,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}`,
  });
  const mergeState = (): PullRequestMergeStateRead => ({
    pullNumber: PULL_NUMBER,
    headSha: state.head,
    mergeable: "MERGEABLE",
    mergeStateStatus: state.draft ? "DRAFT" : "CLEAN",
    draft: state.draft,
  });
  const review = (): PullRequestReviewRead => ({
    id: "review-1",
    state: state.reviewState,
    actor: "reviewer",
    submittedAt: "2026-08-24T12:30:00Z",
  });
  const check = (): CheckRunRead => ({
    id: "check-1",
    name: "validate",
    status: "completed",
    conclusion: state.checkConclusion,
    headSha: state.head,
    appId: null,
    detailsUrl: null,
  });
  const commitStatus = (): CommitStatusRead => ({
    id: "status-1",
    context: "validate",
    state: state.checkConclusion,
    headSha: state.head,
    targetUrl: null,
    createdAt: "2026-08-24T12:30:00Z",
  });

  return {
    state,
    provider: {
      async getRepository(): Promise<RepositoryRef> {
        state.readCalls += 1;
        return repositoryRead();
      },
      async getDefaultBranchHead(): Promise<string> {
        return state.main;
      },
      async listOpenIssues(): Promise<IssueRead[]> {
        return [issue()];
      },
      async listOpenPullRequests(): Promise<PullRequestRead[]> {
        return state.pullState === "open" ? [pull()] : [];
      },
      async getPullRequest(): Promise<PullRequestRead> {
        return pull();
      },
      async getPullRequestMergeState(): Promise<PullRequestMergeStateRead> {
        return mergeState();
      },
      async listPullRequestReviews(): Promise<PullRequestReviewRead[]> {
        return [review()];
      },
      async listCheckRuns(): Promise<CheckRunRead[]> {
        return [check()];
      },
      async listCommitStatuses(): Promise<CommitStatusRead[]> {
        return [commitStatus()];
      },
      async listWorkflowRuns(): Promise<WorkflowRunRead[]> {
        return [];
      },
    },
  };
}

function reviewFeatures() {
  return {
    dismissStaleReviewsOnPush: false,
    requireCodeOwnerReview: false,
    requireLastPushApproval: false,
    requireReviewThreadResolution: false,
    hasRequiredFilePatternReviewers: false,
  } as const;
}

function branchPolicyReader(coverage: "COMPLETE" | "PARTIAL" = "COMPLETE"): BranchPolicyEvidenceReader {
  return {
    async readBranchPolicyEvidence(repository, branch, observedAt): Promise<BranchPolicyEvidence> {
      return {
        repository,
        branch,
        observedAt,
        coverage,
        sources:
          coverage === "COMPLETE"
            ? ["GITHUB_ACTIVE_RULES", "GITHUB_CLASSIC_BRANCH_PROTECTION"]
            : ["GITHUB_ACTIVE_RULES"],
        requiredStatusChecks: [{ context: "validate", integrationId: null }],
        hasUnresolvedRequiredCheckSourceIdentity: false,
        requiredApprovals: 1,
        reviewFeatures: reviewFeatures(),
      };
    },
  };
}

class MemoryAuditStore implements MergeDecisionAuditStore {
  readonly claims: MergeAuditClaimInput[] = [];
  readonly completions: Array<{
    requestId: string;
    fingerprint: string;
    outcome: MergeAuditTerminalOutcome;
  }> = [];
  readonly entries = new Map<string, { fingerprint: string; outcome: MergeAuditTerminalOutcome | null }>();
  forcedClaim: MergeAuditClaimResult | null = null;
  failComplete = false;

  async claim(input: MergeAuditClaimInput): Promise<MergeAuditClaimResult> {
    this.claims.push(input);
    if (this.forcedClaim) return this.forcedClaim;
    const existing = this.entries.get(input.requestId);
    if (!existing) {
      this.entries.set(input.requestId, { fingerprint: input.fingerprint, outcome: null });
      return { kind: "CLAIMED" };
    }
    if (existing.fingerprint !== input.fingerprint) return { kind: "CONFLICT" };
    if (existing.outcome) return { kind: "REPLAY", outcome: existing.outcome };
    return { kind: "IN_PROGRESS" };
  }

  async complete(
    requestId: string,
    fingerprint: string,
    outcome: MergeAuditTerminalOutcome,
  ): Promise<void> {
    if (this.failComplete) throw new Error("audit unavailable");
    const existing = this.entries.get(requestId);
    if (!existing || existing.fingerprint !== fingerprint) throw new Error("audit claim mismatch");
    existing.outcome = outcome;
    this.completions.push({ requestId, fingerprint, outcome });
  }
}

function createWriter(
  calls: GitHubMergePullRequestWriteRequest[],
  behavior: (request: GitHubMergePullRequestWriteRequest) => Promise<{ merged: true; mergeSha: string }> = async () => ({
    merged: true,
    mergeSha: MERGE_SHA,
  }),
): GitHubPullRequestMergeWriter {
  return {
    async merge(request) {
      calls.push(request);
      return behavior(request);
    },
  };
}

function request(overrides: Partial<MergeDecisionRequest> = {}): MergeDecisionRequest {
  return {
    requestId: REQUEST_ID,
    actor: { subject: "access-user-123", email: "andris@example.test" },
    repository: REPOSITORY,
    issueNumber: ISSUE_NUMBER,
    pullNumber: PULL_NUMBER,
    expectedHeadSha: HEAD,
    expectedMainSha: MAIN,
    mergeMethod: "merge",
    ...overrides,
  };
}

function dependencies(
  provider: SourceControlReadProvider,
  writer: GitHubPullRequestMergeWriter,
  auditStore: MergeDecisionAuditStore,
  policyReader: BranchPolicyEvidenceReader = branchPolicyReader(),
) {
  return {
    provider,
    branchPolicyReader: policyReader,
    writer,
    auditStore,
    clock: () => new Date(NOW),
  } as const;
}

async function expectDecisionError(
  promise: Promise<unknown>,
  code: string,
  mutationAttempted: boolean,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof MergeDecisionError &&
      error.code === code &&
      error.mutationAttempted === mutationAttempted,
  );
}

test("fresh complete evidence merges exactly once and records exact head/base/method/actor audit evidence", async () => {
  const { provider, state } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubMergePullRequestWriteRequest[] = [];

  const result = await executeMergeDecision(request(), dependencies(provider, createWriter(writes), audit));

  assert.equal(state.readCalls, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    repository: REPOSITORY,
    pullNumber: PULL_NUMBER,
    expectedHeadSha: HEAD,
    mergeMethod: "merge",
    observedAt: NOW.toISOString(),
  });
  assert.equal(result.status, "MERGED");
  assert.equal(result.mergeSha, MERGE_SHA);
  assert.equal(result.observedHeadSha, HEAD);
  assert.equal(result.observedMainSha, MAIN);
  assert.equal(audit.claims.length, 1);
  assert.equal(audit.claims[0].mergeMethod, "merge");
  assert.match(audit.claims[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(audit.completions[0].outcome.kind, "SUCCEEDED");
});

test("stale head and stale main fail closed before writer invocation", async () => {
  const cases = [
    { provider: createProvider({ head: OTHER_HEAD }).provider, code: "AUTHORIZATION_STALE_HEAD" },
    { provider: createProvider({ main: OTHER_MAIN }).provider, code: "AUTHORIZATION_STALE_BASE" },
  ];

  for (const candidate of cases) {
    const audit = new MemoryAuditStore();
    const writes: GitHubMergePullRequestWriteRequest[] = [];
    await expectDecisionError(
      executeMergeDecision(request({ requestId: `${REQUEST_ID}_${candidate.code}` }), dependencies(candidate.provider, createWriter(writes), audit)),
      candidate.code,
      false,
    );
    assert.equal(writes.length, 0);
    assert.equal(audit.completions[0].outcome.kind, "FAILED");
  }
});

test("incomplete branch-policy evidence fails closed before writer invocation", async () => {
  const { provider } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubMergePullRequestWriteRequest[] = [];

  await expectDecisionError(
    executeMergeDecision(request(), dependencies(provider, createWriter(writes), audit, branchPolicyReader("PARTIAL"))),
    "POLICY_EVIDENCE_INCOMPLETE",
    false,
  );
  assert.equal(writes.length, 0);
});

test("closed, draft, failed-CI and changes-requested states never reach the writer", async () => {
  const states: Partial<ProviderState>[] = [
    { pullState: "closed" },
    { draft: true },
    { checkConclusion: "failure" },
    { reviewState: "CHANGES_REQUESTED" },
  ];

  for (let index = 0; index < states.length; index += 1) {
    const { provider } = createProvider(states[index]);
    const audit = new MemoryAuditStore();
    const writes: GitHubMergePullRequestWriteRequest[] = [];
    await expectDecisionError(
      executeMergeDecision(
        request({ requestId: `${REQUEST_ID}_notready_${index}` }),
        dependencies(provider, createWriter(writes), audit),
      ),
      "DECISION_NOT_READY",
      false,
    );
    assert.equal(writes.length, 0);
  }
});

test("matching successful replay returns stored merge without reread or second write", async () => {
  const { provider, state } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubMergePullRequestWriteRequest[] = [];
  const deps = dependencies(provider, createWriter(writes), audit);

  const first = await executeMergeDecision(request(), deps);
  const readsAfterFirst = state.readCalls;
  const second = await executeMergeDecision(request(), deps);

  assert.deepEqual(second, first);
  assert.equal(state.readCalls, readsAfterFirst);
  assert.equal(writes.length, 1);
});

test("conflicting or in-progress request id fails before authoritative reread or write", async () => {
  for (const kind of ["CONFLICT", "IN_PROGRESS"] as const) {
    const { provider, state } = createProvider();
    const audit = new MemoryAuditStore();
    audit.forcedClaim = { kind };
    const writes: GitHubMergePullRequestWriteRequest[] = [];

    await expectDecisionError(
      executeMergeDecision(request(), dependencies(provider, createWriter(writes), audit)),
      kind === "CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "IDEMPOTENCY_IN_PROGRESS",
      false,
    );
    assert.equal(state.readCalls, 0);
    assert.equal(writes.length, 0);
  }
});

test("writer HEAD_CONFLICT is terminal stale-head evidence and is never retried", async () => {
  const { provider } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubMergePullRequestWriteRequest[] = [];
  const writer = createWriter(writes, async () => {
    throw new GitHubPullRequestMergeWriteError("HEAD_CONFLICT", 409);
  });

  await expectDecisionError(
    executeMergeDecision(request(), dependencies(provider, writer, audit)),
    "AUTHORIZATION_STALE_HEAD",
    true,
  );
  assert.equal(writes.length, 1);
  assert.deepEqual(audit.completions[0].outcome, {
    kind: "FAILED",
    code: "AUTHORIZATION_STALE_HEAD",
    mutationAttempted: true,
  });
});

test("ambiguous writer outcome is durable UNKNOWN and replay never performs a second write", async () => {
  const { provider, state } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubMergePullRequestWriteRequest[] = [];
  const writer = createWriter(writes, async () => {
    throw new GitHubPullRequestMergeWriteError("WRITE_OUTCOME_UNKNOWN");
  });
  const deps = dependencies(provider, writer, audit);

  await expectDecisionError(executeMergeDecision(request(), deps), "WRITE_OUTCOME_UNKNOWN", true);
  const readsAfterFirst = state.readCalls;
  await expectDecisionError(executeMergeDecision(request(), deps), "WRITE_OUTCOME_UNKNOWN", true);

  assert.equal(writes.length, 1);
  assert.equal(state.readCalls, readsAfterFirst);
  assert.deepEqual(audit.completions[0].outcome, {
    kind: "UNKNOWN",
    code: "WRITE_OUTCOME_UNKNOWN",
    mutationAttempted: true,
  });
});

test("audit finalization failure after successful writer is non-retryable and does not issue a second write", async () => {
  const { provider } = createProvider();
  const audit = new MemoryAuditStore();
  audit.failComplete = true;
  const writes: GitHubMergePullRequestWriteRequest[] = [];

  await expectDecisionError(
    executeMergeDecision(request(), dependencies(provider, createWriter(writes), audit)),
    "AUDIT_FINALIZATION_FAILED",
    true,
  );
  assert.equal(writes.length, 1);
});

test("invalid request shape fails before audit, reread or writer", async () => {
  const { provider, state } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubMergePullRequestWriteRequest[] = [];

  await expectDecisionError(
    executeMergeDecision(
      request({ expectedHeadSha: "BAD", mergeMethod: "octopus" as never }),
      dependencies(provider, createWriter(writes), audit),
    ),
    "INVALID_REQUEST",
    false,
  );
  assert.equal(audit.claims.length, 0);
  assert.equal(state.readCalls, 0);
  assert.equal(writes.length, 0);
});
