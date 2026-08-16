import assert from "node:assert/strict";
import test from "node:test";

import {
  executeNeedsChangesDecision,
  NeedsChangesDecisionError,
  type NeedsChangesAuditClaimInput,
  type NeedsChangesAuditClaimResult,
  type NeedsChangesAuditTerminalOutcome,
  type NeedsChangesDecisionAuditStore,
  type NeedsChangesDecisionRequest,
} from "../src/shared/needs-changes-decision.js";
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
  GitHubPullRequestReviewWriteError,
  type GitHubPullRequestReviewWriter,
  type GitHubRequestChangesWriteRequest,
} from "../src/integrations/github/pull-request-review-write.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const ISSUE_NUMBER = 47;
const PULL_NUMBER = 48;
const HEAD = "1111111111111111111111111111111111111111";
const OTHER_HEAD = "3333333333333333333333333333333333333333";
const MAIN = "2222222222222222222222222222222222222222";
const OTHER_MAIN = "4444444444444444444444444444444444444444";
const NOW = new Date("2026-08-16T14:10:00.000Z");
const REQUEST_ID = "request_209_00001";

interface ProviderState {
  head: string;
  main: string;
  issueOpen: boolean;
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
    issueOpen: true,
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
    title: "Guarded Needs changes decision",
    state: "open",
    htmlUrl: `https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
  });
  const pull = (): PullRequestRead => ({
    number: PULL_NUMBER,
    title: "Phase 3 guarded review boundary",
    state: state.pullState,
    draft: state.draft,
    baseRef: "main",
    baseSha: state.main,
    headRef: "feat/phase3",
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
    submittedAt: "2026-08-16T13:00:00Z",
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
    createdAt: "2026-08-16T13:00:00Z",
  });

  const provider: SourceControlReadProvider = {
    async getRepository(): Promise<RepositoryRef> {
      state.readCalls += 1;
      return repositoryRead();
    },
    async getDefaultBranchHead(): Promise<string> {
      return state.main;
    },
    async listOpenIssues(): Promise<IssueRead[]> {
      return state.issueOpen ? [issue()] : [];
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
  };

  return { provider, state };
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

class MemoryAuditStore implements NeedsChangesDecisionAuditStore {
  readonly claims: NeedsChangesAuditClaimInput[] = [];
  readonly completions: Array<{
    requestId: string;
    fingerprint: string;
    outcome: NeedsChangesAuditTerminalOutcome;
  }> = [];
  readonly entries = new Map<string, { fingerprint: string; outcome: NeedsChangesAuditTerminalOutcome | null }>();
  forcedClaim: NeedsChangesAuditClaimResult | null = null;
  failComplete = false;

  async claim(input: NeedsChangesAuditClaimInput): Promise<NeedsChangesAuditClaimResult> {
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
    outcome: NeedsChangesAuditTerminalOutcome,
  ): Promise<void> {
    if (this.failComplete) throw new Error("audit unavailable");
    const existing = this.entries.get(requestId);
    if (!existing || existing.fingerprint !== fingerprint) throw new Error("audit claim mismatch");
    existing.outcome = outcome;
    this.completions.push({ requestId, fingerprint, outcome });
  }
}

function createWriter(
  calls: GitHubRequestChangesWriteRequest[],
  behavior: (request: GitHubRequestChangesWriteRequest) => Promise<ReturnTypeResult> = async () => successWrite(),
): GitHubPullRequestReviewWriter {
  return {
    async requestChanges(request) {
      calls.push(request);
      return behavior(request);
    },
  };
}

type ReturnTypeResult = Awaited<ReturnType<GitHubPullRequestReviewWriter["requestChanges"]>>;

function successWrite(): ReturnTypeResult {
  return {
    reviewId: "80",
    state: "CHANGES_REQUESTED",
    commitId: HEAD,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}#pullrequestreview-80`,
    submittedAt: "2026-08-16T14:10:01.000Z",
  };
}

function request(overrides: Partial<NeedsChangesDecisionRequest> = {}): NeedsChangesDecisionRequest {
  return {
    requestId: REQUEST_ID,
    actor: { subject: "access-user-123", email: "andris@example.test" },
    repository: REPOSITORY,
    issueNumber: ISSUE_NUMBER,
    pullNumber: PULL_NUMBER,
    expectedHeadSha: HEAD,
    expectedMainSha: MAIN,
    body: "Please address the reviewed issues before this is merged.",
    ...overrides,
  };
}

function dependencies(
  provider: SourceControlReadProvider,
  writer: GitHubPullRequestReviewWriter,
  auditStore: NeedsChangesDecisionAuditStore,
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
      error instanceof NeedsChangesDecisionError &&
      error.code === code &&
      error.mutationAttempted === mutationAttempted,
  );
}

test("fresh complete evidence requests changes exactly once and records exact head/base/actor audit evidence", async () => {
  const { provider, state } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubRequestChangesWriteRequest[] = [];

  const result = await executeNeedsChangesDecision(
    request(),
    dependencies(provider, createWriter(writes), audit),
  );

  assert.equal(state.readCalls, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    repository: REPOSITORY,
    pullNumber: PULL_NUMBER,
    expectedHeadSha: HEAD,
    body: "Please address the reviewed issues before this is merged.",
    observedAt: NOW.toISOString(),
  });
  assert.equal(result.status, "CHANGES_REQUESTED");
  assert.equal(result.expectedHeadSha, HEAD);
  assert.equal(result.observedHeadSha, HEAD);
  assert.equal(result.expectedMainSha, MAIN);
  assert.equal(result.observedMainSha, MAIN);
  assert.equal(result.observedAt, NOW.toISOString());
  assert.deepEqual(result.actor, { subject: "access-user-123", email: "andris@example.test" });
  assert.equal(audit.claims.length, 1);
  assert.match(audit.claims[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(audit.claims[0].requestedAt, NOW.toISOString());
  assert.equal(audit.completions.length, 1);
  assert.equal(audit.completions[0].outcome.kind, "SUCCEEDED");
});

test("stale owner-approved head fails closed after fresh reread and before writer invocation", async () => {
  const { provider } = createProvider({ head: OTHER_HEAD });
  const audit = new MemoryAuditStore();
  const writes: GitHubRequestChangesWriteRequest[] = [];

  await expectDecisionError(
    executeNeedsChangesDecision(request(), dependencies(provider, createWriter(writes), audit)),
    "AUTHORIZATION_STALE_HEAD",
    false,
  );
  assert.equal(writes.length, 0);
  assert.equal(audit.completions[0].outcome.kind, "FAILED");
});

test("changed default-branch head invalidates the owner-approved base before mutation", async () => {
  const { provider } = createProvider({ main: OTHER_MAIN });
  const audit = new MemoryAuditStore();
  const writes: GitHubRequestChangesWriteRequest[] = [];

  await expectDecisionError(
    executeNeedsChangesDecision(request(), dependencies(provider, createWriter(writes), audit)),
    "AUTHORIZATION_STALE_BASE",
    false,
  );
  assert.equal(writes.length, 0);
});

test("incomplete branch-policy evidence fails closed before mutation", async () => {
  const { provider } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubRequestChangesWriteRequest[] = [];

  await expectDecisionError(
    executeNeedsChangesDecision(
      request(),
      dependencies(provider, createWriter(writes), audit, branchPolicyReader("PARTIAL")),
    ),
    "POLICY_EVIDENCE_INCOMPLETE",
    false,
  );
  assert.equal(writes.length, 0);
});

test("closed, draft, failed-CI and already-changes-requested states never reach the writer", async () => {
  const states: Partial<ProviderState>[] = [
    { pullState: "closed" },
    { draft: true },
    { checkConclusion: "failure" },
    { reviewState: "CHANGES_REQUESTED" },
  ];

  for (const state of states) {
    const { provider } = createProvider(state);
    const audit = new MemoryAuditStore();
    const writes: GitHubRequestChangesWriteRequest[] = [];
    await expectDecisionError(
      executeNeedsChangesDecision(
        request({ requestId: `${REQUEST_ID}_${states.indexOf(state)}` }),
        dependencies(provider, createWriter(writes), audit),
      ),
      state.pullState === "closed" ? "RECONCILIATION_FAILED" : "DECISION_NOT_READY",
      false,
    );
    assert.equal(writes.length, 0);
  }
});

test("successful replay returns stored result without rereading GitHub or writing a second review", async () => {
  const { provider, state } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubRequestChangesWriteRequest[] = [];
  const deps = dependencies(provider, createWriter(writes), audit);

  const first = await executeNeedsChangesDecision(request(), deps);
  const readsAfterFirst = state.readCalls;
  const second = await executeNeedsChangesDecision(request(), deps);

  assert.deepEqual(second, first);
  assert.equal(state.readCalls, readsAfterFirst);
  assert.equal(writes.length, 1);
});

test("conflicting or in-progress idempotency claims fail before live reread or mutation", async () => {
  for (const kind of ["CONFLICT", "IN_PROGRESS"] as const) {
    const { provider, state } = createProvider();
    const audit = new MemoryAuditStore();
    audit.forcedClaim = { kind };
    const writes: GitHubRequestChangesWriteRequest[] = [];

    await expectDecisionError(
      executeNeedsChangesDecision(request(), dependencies(provider, createWriter(writes), audit)),
      kind === "CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "IDEMPOTENCY_IN_PROGRESS",
      false,
    );
    assert.equal(state.readCalls, 0);
    assert.equal(writes.length, 0);
  }
});

test("definitive GitHub rejection is terminal for the request id and never auto-retries", async () => {
  const { provider } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubRequestChangesWriteRequest[] = [];
  const writer = createWriter(writes, async () => {
    throw new GitHubPullRequestReviewWriteError("FORBIDDEN", 403);
  });
  const deps = dependencies(provider, writer, audit);

  await expectDecisionError(executeNeedsChangesDecision(request(), deps), "WRITE_REJECTED", true);
  assert.equal(writes.length, 1);
  await expectDecisionError(executeNeedsChangesDecision(request(), deps), "WRITE_REJECTED", false);
  assert.equal(writes.length, 1);
});

test("unknown write outcome is terminal and replay never submits a second review", async () => {
  const { provider } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubRequestChangesWriteRequest[] = [];
  const writer = createWriter(writes, async () => {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN");
  });
  const deps = dependencies(provider, writer, audit);

  await expectDecisionError(executeNeedsChangesDecision(request(), deps), "WRITE_OUTCOME_UNKNOWN", true);
  assert.equal(writes.length, 1);
  assert.equal(audit.completions[0].outcome.kind, "UNKNOWN");
  await expectDecisionError(executeNeedsChangesDecision(request(), deps), "WRITE_OUTCOME_UNKNOWN", false);
  assert.equal(writes.length, 1);
});

test("audit finalization failure after a successful write leaves the claim in progress so retry cannot duplicate mutation", async () => {
  const { provider } = createProvider();
  const audit = new MemoryAuditStore();
  audit.failComplete = true;
  const writes: GitHubRequestChangesWriteRequest[] = [];
  const deps = dependencies(provider, createWriter(writes), audit);

  await expectDecisionError(executeNeedsChangesDecision(request(), deps), "AUDIT_FINALIZATION_FAILED", true);
  assert.equal(writes.length, 1);

  audit.failComplete = false;
  await expectDecisionError(executeNeedsChangesDecision(request(), deps), "IDEMPOTENCY_IN_PROGRESS", false);
  assert.equal(writes.length, 1);
});

test("invalid request fails before audit claim, authoritative reread or mutation", async () => {
  const { provider, state } = createProvider();
  const audit = new MemoryAuditStore();
  const writes: GitHubRequestChangesWriteRequest[] = [];

  await expectDecisionError(
    executeNeedsChangesDecision(
      request({ repository: "rozkalnsandris/hermes-email-skill" }),
      dependencies(provider, createWriter(writes), audit),
    ),
    "INVALID_REQUEST",
    false,
  );
  assert.equal(audit.claims.length, 0);
  assert.equal(state.readCalls, 0);
  assert.equal(writes.length, 0);
});
