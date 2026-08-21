import {
  MAX_CONTINUATION_CANDIDATES,
  type ContinuationGithubSnapshot,
  type ContinuationTaskCandidate,
  type ContinuationTaskState,
} from "./continuation-plan.js";
import { requireManagedProjectPolicy } from "./project-policy.js";
import type {
  IssueRead,
  PullRequestRead,
  SourceControlReadProvider,
} from "./source-control-read.js";

export type ContinuationGithubReadProvider = Pick<
  SourceControlReadProvider,
  "getRepository" | "getDefaultBranchHead" | "listOpenIssues" | "listOpenPullRequests"
>;

export type ContinuationTaskBinding = Omit<ContinuationTaskCandidate, "issueState"> & {
  readonly expectedHeadSha: string | null;
};

export type ContinuationGithubSnapshotErrorCode =
  | "INVALID_INPUT"
  | "REPOSITORY_NOT_ALLOWED"
  | "REPOSITORY_EVIDENCE_MISMATCH"
  | "TOO_MANY_RECORDS"
  | "DUPLICATE_EVIDENCE"
  | "MAIN_SHA_DRIFT"
  | "ISSUE_EVIDENCE_MISSING"
  | "UNSUPPORTED_ISSUE_EVIDENCE"
  | "PULL_REQUEST_EVIDENCE_MISSING"
  | "EXPECTED_PULL_REQUEST_HEAD_DRIFT"
  | "UNATTRIBUTED_OPEN_PULL_REQUEST";

export class ContinuationGithubSnapshotError extends Error {
  readonly code: ContinuationGithubSnapshotErrorCode;

  constructor(code: ContinuationGithubSnapshotErrorCode) {
    super("Authoritative continuation GitHub observation failed closed");
    this.name = "ContinuationGithubSnapshotError";
    this.code = code;
  }
}

export const MAX_CONTINUATION_PROVIDER_RECORDS = 500;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAIN_SHA_PATTERN = /^[0-9a-f]{40}$/;
const TASK_STATES = new Set<ContinuationTaskState>([
  "DISCOVERED",
  "READY",
  "WORKING",
  "WAITING",
  "PR_DRAFT",
  "WAIT_CI",
  "REVIEW",
  "NEEDS_ANDRIS",
  "MERGE_READY",
  "MERGED",
  "DEPLOY_DECISION",
  "PRODUCTION_VERIFY",
  "DONE",
  "PAUSED",
  "BLOCKED",
  "CI_FAILED",
  "CANCELLED",
]);

function fail(code: ContinuationGithubSnapshotErrorCode): never {
  throw new ContinuationGithubSnapshotError(code);
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("INVALID_INPUT");
  }
  return value;
}

function requireMainSha(value: unknown): string {
  if (typeof value !== "string" || !MAIN_SHA_PATTERN.test(value)) fail("INVALID_INPUT");
  return value;
}

function validateBindings(
  bindings: readonly ContinuationTaskBinding[],
  repository: string,
  projectId: string,
): void {
  if (!Array.isArray(bindings)) fail("INVALID_INPUT");
  if (bindings.length > MAX_CONTINUATION_CANDIDATES) fail("TOO_MANY_RECORDS");

  const taskIds = new Set<string>();
  const issueNumbers = new Set<number>();
  const pullNumbers = new Set<number>();

  for (const binding of bindings) {
    if (!binding || typeof binding !== "object") fail("INVALID_INPUT");
    if (typeof binding.taskId !== "string" || !IDENTIFIER_PATTERN.test(binding.taskId)) {
      fail("INVALID_INPUT");
    }
    if (binding.repository !== repository || binding.projectId !== projectId) {
      fail("REPOSITORY_EVIDENCE_MISMATCH");
    }
    if (!validNumber(binding.issueNumber)) fail("INVALID_INPUT");
    if (
      typeof binding.taskState !== "string" ||
      !TASK_STATES.has(binding.taskState as ContinuationTaskState)
    ) {
      fail("INVALID_INPUT");
    }
    if (
      !Number.isSafeInteger(binding.priority) ||
      binding.priority < 0 ||
      binding.priority > 1_000_000
    ) {
      fail("INVALID_INPUT");
    }
    if (taskIds.has(binding.taskId) || issueNumbers.has(binding.issueNumber)) {
      fail("DUPLICATE_EVIDENCE");
    }
    taskIds.add(binding.taskId);
    issueNumbers.add(binding.issueNumber);

    const hasActivePullRequest = binding.activePullRequestNumber !== null;
    const hasExpectedHead = binding.expectedHeadSha !== null;
    if (hasActivePullRequest !== hasExpectedHead) fail("INVALID_INPUT");
    if (binding.expectedHeadSha !== null) requireMainSha(binding.expectedHeadSha);

    if (binding.activePullRequestNumber !== null) {
      if (!validNumber(binding.activePullRequestNumber)) fail("INVALID_INPUT");
      if (pullNumbers.has(binding.activePullRequestNumber)) fail("DUPLICATE_EVIDENCE");
      pullNumbers.add(binding.activePullRequestNumber);
    }
  }
}

function validateOpenIssues(issues: IssueRead[], repository: string): Map<number, IssueRead> {
  if (!Array.isArray(issues)) fail("INVALID_INPUT");
  if (issues.length > MAX_CONTINUATION_PROVIDER_RECORDS) fail("TOO_MANY_RECORDS");

  const byNumber = new Map<number, IssueRead>();
  for (const issue of issues) {
    if (!issue || typeof issue !== "object" || !validNumber(issue.number)) fail("INVALID_INPUT");
    if (issue.state !== "open") fail("UNSUPPORTED_ISSUE_EVIDENCE");
    if (issue.htmlUrl !== `https://github.com/${repository}/issues/${issue.number}`) {
      fail("REPOSITORY_EVIDENCE_MISMATCH");
    }
    if (byNumber.has(issue.number)) fail("DUPLICATE_EVIDENCE");
    byNumber.set(issue.number, issue);
  }
  return byNumber;
}

function validateOpenPullRequests(
  pulls: PullRequestRead[],
  repository: string,
): Map<number, PullRequestRead> {
  if (!Array.isArray(pulls)) fail("INVALID_INPUT");
  if (pulls.length > MAX_CONTINUATION_PROVIDER_RECORDS) fail("TOO_MANY_RECORDS");

  const byNumber = new Map<number, PullRequestRead>();
  for (const pull of pulls) {
    if (!pull || typeof pull !== "object" || !validNumber(pull.number)) fail("INVALID_INPUT");
    if (pull.state !== "open") fail("PULL_REQUEST_EVIDENCE_MISSING");
    if (pull.htmlUrl !== `https://github.com/${repository}/pull/${pull.number}`) {
      fail("REPOSITORY_EVIDENCE_MISMATCH");
    }
    if (byNumber.has(pull.number)) fail("DUPLICATE_EVIDENCE");
    byNumber.set(pull.number, pull);
  }
  return byNumber;
}

/**
 * Observe existing GitHub read capabilities without scheduling or mutating.
 *
 * Task-to-PR associations must be explicit. Unattributed or missing open PRs
 * fail closed; issue/PR relationships are never inferred from titles or refs.
 * A double default-branch-head read rejects races around the observation.
 */
export async function readContinuationGithubSnapshot(
  provider: ContinuationGithubReadProvider,
  repositoryInput: string,
  projectIdInput: string,
  bindings: readonly ContinuationTaskBinding[],
  observedAtInput: string,
): Promise<ContinuationGithubSnapshot> {
  if (
    !provider ||
    typeof provider !== "object" ||
    typeof provider.getRepository !== "function" ||
    typeof provider.getDefaultBranchHead !== "function" ||
    typeof provider.listOpenIssues !== "function" ||
    typeof provider.listOpenPullRequests !== "function"
  ) {
    fail("INVALID_INPUT");
  }

  const observedAt = requireTimestamp(observedAtInput);
  let policy;
  try {
    policy = requireManagedProjectPolicy(repositoryInput);
  } catch {
    fail("REPOSITORY_NOT_ALLOWED");
  }
  if (repositoryInput !== policy.repository || projectIdInput !== policy.id) {
    fail("REPOSITORY_EVIDENCE_MISMATCH");
  }
  validateBindings(bindings, policy.repository, policy.id);

  const repository = await provider.getRepository(policy.repository);
  if (!repository || repository.repository !== policy.repository) {
    fail("REPOSITORY_EVIDENCE_MISMATCH");
  }
  if (
    typeof repository.defaultBranch !== "string" ||
    repository.defaultBranch.length === 0 ||
    repository.defaultBranch.length > 128 ||
    /\s/u.test(repository.defaultBranch)
  ) {
    fail("INVALID_INPUT");
  }

  const beforeMainSha = requireMainSha(
    await provider.getDefaultBranchHead(policy.repository, repository.defaultBranch),
  );
  const [issues, pulls] = await Promise.all([
    provider.listOpenIssues(policy.repository),
    provider.listOpenPullRequests(policy.repository),
  ]);
  const afterMainSha = requireMainSha(
    await provider.getDefaultBranchHead(policy.repository, repository.defaultBranch),
  );
  if (afterMainSha !== beforeMainSha) fail("MAIN_SHA_DRIFT");

  const openIssues = validateOpenIssues(issues, policy.repository);
  const openPulls = validateOpenPullRequests(pulls, policy.repository);
  const attributedPulls = new Set<number>();
  const candidates: ContinuationTaskCandidate[] = [];

  for (const binding of bindings) {
    if (!openIssues.has(binding.issueNumber)) fail("ISSUE_EVIDENCE_MISSING");
    if (binding.activePullRequestNumber !== null) {
      const observedPull = openPulls.get(binding.activePullRequestNumber);
      if (!observedPull) fail("PULL_REQUEST_EVIDENCE_MISSING");
      if (observedPull.headSha !== binding.expectedHeadSha) {
        fail("EXPECTED_PULL_REQUEST_HEAD_DRIFT");
      }
      attributedPulls.add(binding.activePullRequestNumber);
    }
    candidates.push({
      taskId: binding.taskId,
      projectId: binding.projectId,
      repository: binding.repository,
      issueNumber: binding.issueNumber,
      issueState: "OPEN",
      taskState: binding.taskState,
      activePullRequestNumber: binding.activePullRequestNumber,
      priority: binding.priority,
    });
  }

  if (openPulls.size !== attributedPulls.size) fail("UNATTRIBUTED_OPEN_PULL_REQUEST");

  return {
    schemaVersion: 1,
    repository: policy.repository,
    mainSha: beforeMainSha,
    observedAt,
    candidates,
  };
}
