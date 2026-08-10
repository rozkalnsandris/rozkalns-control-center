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
  detailsUrl: string | null;
}

export interface WorkflowRunRead {
  id: string;
  name: string;
  status: WorkflowRunStatus;
  conclusion: string | null;
  headSha: string;
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
  listWorkflowRuns(repository: string, headSha: string): Promise<WorkflowRunRead[]>;
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
  workflowRuns: readonly WorkflowRunRead[];
  authoritativeRead: true;
}

export async function readAuthoritativePullRequestSnapshot(
  provider: SourceControlReadProvider,
  repository: string,
  pullNumber: number,
  observedAt: string,
): Promise<ChangeRequestReadSnapshot> {
  requireManagedProjectPolicy(repository);

  const repositoryRead = await provider.getRepository(repository);
  if (repositoryRead.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Source-control provider returned a different repository than requested");
  }

  const pullRequest = await provider.getPullRequest(repository, pullNumber);
  if (pullRequest.number !== pullNumber) {
    throw new Error("Source-control provider returned a different pull request than requested");
  }

  const [mainSha, mergeState, reviews, checkRuns, workflowRuns] = await Promise.all([
    provider.getDefaultBranchHead(repository, repositoryRead.defaultBranch),
    provider.getPullRequestMergeState(repository, pullNumber),
    provider.listPullRequestReviews(repository, pullNumber),
    provider.listCheckRuns(repository, pullRequest.headSha),
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
    workflowRuns,
    authoritativeRead: true,
  };
}
