import { requireManagedProjectPolicy } from "./project-policy.js";

export type PullRequestState = "open" | "closed";
export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "startup_failure"
  | null;
export type CheckRunStatus = "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
export type CommitStatusState = "error" | "failure" | "pending" | "success";
export type CommitStatusEvidenceCoverage = "OBSERVED" | "NOT_REQUESTED";
export type WorkflowRunStatus = "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
export type PullRequestMergeability = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type PullRequestMergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE";

export interface ReviewThreadResolutionEvidenceRead {
  coverage: "COMPLETE";
  totalCount: number;
  unresolvedCount: number;
}

export interface RepositoryRef {
  repository: string;
  defaultBranch: string;
}

export interface PullRequestRead {
  number: number;
  title: string;
  state: PullRequestState;
  draft: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  changedFiles: number;
  htmlUrl: string;
}

export interface PullRequestMergeStateRead {
  pullNumber: number;
  headSha: string;
  mergeable: PullRequestMergeability;
  mergeStateStatus: PullRequestMergeStateStatus;
  draft: boolean;
  reviewThreadResolution?: ReviewThreadResolutionEvidenceRead;
}

export interface PullRequestReviewRead {
  id: string;
  state: ReviewState;
  actor: string;
  submittedAt: string | null;
}

export interface CheckRunRead {
  id: string;
  name: string;
  status: CheckRunStatus;
  conclusion: CheckConclusion;
  headSha: string;
  appId: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  detailsUrl: string | null;
}

export interface CommitStatusRead {
  id: string;
  context: string;
  state: CommitStatusState;
  headSha: string;
  targetUrl: string | null;
  createdAt: string;
}

export interface WorkflowRunRead {
  id: string;
  workflowId?: string | null;
  runNumber?: number | null;
  runAttempt?: number | null;
  name: string;
  status: WorkflowRunStatus;
  conclusion: string | null;
  headSha: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  runStartedAt?: string | null;
  htmlUrl: string;
}

export interface IssueRead {
  number: number;
  title: string;
  state: "open" | "closed";
  htmlUrl: string;
}

export interface SourceControlReadProvider {
  getRepository(repository: string): Promise<RepositoryRef>;
  getDefaultBranchHead(repository: string, defaultBranch: string): Promise<string>;
  listOpenIssues(repository: string): Promise<IssueRead[]>;
  listOpenPullRequests(repository: string): Promise<PullRequestRead[]>;
  getPullRequest(repository: string, pullNumber: number): Promise<PullRequestRead>;
  getPullRequestMergeState(repository: string, pullNumber: number): Promise<PullRequestMergeStateRead>;
  listPullRequestReviews(repository: string, pullNumber: number): Promise<PullRequestReviewRead[]>;
  listCheckRuns(repository: string, headSha: string): Promise<CheckRunRead[]>;
  listCommitStatuses(repository: string, headSha: string): Promise<CommitStatusRead[]>;
  listWorkflowRuns(repository: string, headSha: string): Promise<WorkflowRunRead[]>;
}

export interface AuthoritativeReadOptions {
  readonly commitStatusCoverage?: CommitStatusEvidenceCoverage;
}

export interface ChangeRequestReadSnapshot {
  repository: string;
  observedAt: string;
  defaultBranch: string;
  mainSha: string;
  pullRequest: PullRequestRead;
  mergeState: PullRequestMergeStateRead;
  reviews: readonly PullRequestReviewRead[];
  checkRuns: readonly CheckRunRead[];
  commitStatuses: readonly CommitStatusRead[];
  commitStatusCoverage: CommitStatusEvidenceCoverage;
  workflowRuns: readonly WorkflowRunRead[];
  authoritativeRead: true;
}

function normalizeCommitStatusCoverage(value: CommitStatusEvidenceCoverage | undefined): CommitStatusEvidenceCoverage {
  if (value === undefined || value === "OBSERVED") return "OBSERVED";
  if (value === "NOT_REQUESTED") return "NOT_REQUESTED";
  throw new Error("Unsupported commit-status evidence coverage");
}

export async function readAuthoritativePullRequestSnapshot(
  provider: SourceControlReadProvider,
  repository: string,
  pullNumber: number,
  observedAt: string,
  options: AuthoritativeReadOptions = {},
): Promise<ChangeRequestReadSnapshot> {
  requireManagedProjectPolicy(repository);
  const commitStatusCoverage = normalizeCommitStatusCoverage(options.commitStatusCoverage);

  const repositoryRead = await provider.getRepository(repository);
  if (repositoryRead.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Source-control provider returned a different repository than requested");
  }

  const pullRequest = await provider.getPullRequest(repository, pullNumber);
  if (pullRequest.number !== pullNumber) {
    throw new Error("Source-control provider returned a different pull request than requested");
  }

  const commitStatusesPromise =
    commitStatusCoverage === "OBSERVED"
      ? provider.listCommitStatuses(repository, pullRequest.headSha)
      : Promise.resolve<CommitStatusRead[]>([]);

  const [mainSha, mergeState, reviews, checkRuns, commitStatuses, workflowRuns] = await Promise.all([
    provider.getDefaultBranchHead(repository, repositoryRead.defaultBranch),
    provider.getPullRequestMergeState(repository, pullNumber),
    provider.listPullRequestReviews(repository, pullNumber),
    provider.listCheckRuns(repository, pullRequest.headSha),
    commitStatusesPromise,
    provider.listWorkflowRuns(repository, pullRequest.headSha),
  ]);

  if (mergeState.pullNumber !== pullRequest.number) {
    throw new Error("Merge-state evidence does not match the observed pull request number");
  }
  if (mergeState.headSha !== pullRequest.headSha) {
    throw new Error("Merge-state evidence does not match the observed pull-request head SHA");
  }
  if (mergeState.draft !== pullRequest.draft) {
    throw new Error("Merge-state evidence disagrees with the observed pull-request draft state");
  }

  for (const check of checkRuns) {
    if (check.headSha !== pullRequest.headSha) {
      throw new Error("Check-run evidence does not match the observed pull-request head SHA");
    }
  }

  for (const status of commitStatuses) {
    if (status.headSha !== pullRequest.headSha) {
      throw new Error("Commit-status evidence does not match the observed pull-request head SHA");
    }
  }

  for (const run of workflowRuns) {
    if (run.headSha !== pullRequest.headSha) {
      throw new Error("Workflow evidence does not match the observed pull-request head SHA");
    }
  }

  return {
    repository,
    observedAt,
    defaultBranch: repositoryRead.defaultBranch,
    mainSha,
    pullRequest,
    mergeState,
    reviews,
    checkRuns,
    commitStatuses,
    commitStatusCoverage,
    workflowRuns,
    authoritativeRead: true,
  };
}
