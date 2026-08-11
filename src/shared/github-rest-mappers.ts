import {
  selectLatestEffectiveCheckRuns,
  selectLatestEffectiveCommitStatuses,
  selectLatestEffectiveWorkflowRuns,
} from "./github-evidence-selection.js";
import type {
  CheckConclusion,
  CheckRunRead,
  CheckRunStatus,
  CommitStatusRead,
  CommitStatusState,
  IssueRead,
  PullRequestRead,
  PullRequestReviewRead,
  RepositoryRef,
  ReviewState,
  WorkflowRunRead,
  WorkflowRunStatus,
} from "./source-control-read.js";

class GitHubPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubPayloadError";
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubPayloadError(`${field} must be an object`);
  }
  return value as JsonRecord;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubPayloadError(`${field} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return stringField(value, field);
}

function timestampField(value: unknown, field: string): string {
  const result = stringField(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new GitHubPayloadError(`${field} must be an ISO timestamp`);
  return result;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return timestampField(value, field);
}

function integerField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new GitHubPayloadError(`${field} must be a non-negative integer`);
  }
  return value;
}

function positiveIntegerField(value: unknown, field: string): number {
  const result = integerField(value, field);
  if (result === 0) throw new GitHubPayloadError(`${field} must be a positive integer`);
  return result;
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new GitHubPayloadError(`${field} must be a boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new GitHubPayloadError(`${field} has an unsupported value`);
  }
  return value as T;
}

const reviewStates = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"] as const;
const checkStatuses = ["queued", "in_progress", "completed", "waiting", "requested", "pending"] as const;
const checkConclusions = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
] as const;
const commitStatusStates = ["error", "failure", "pending", "success"] as const;
const workflowStatuses = ["queued", "in_progress", "completed", "waiting", "requested", "pending"] as const;

function checkRunAppId(input: JsonRecord): number | null {
  if (!("app" in input) || input.app === null) return null;
  const app = record(input.app, "check_run.app");
  return positiveIntegerField(app.id, "check_run.app.id");
}

export function mapGitHubRepository(payload: unknown): RepositoryRef {
  const input = record(payload, "repository");
  return {
    repository: stringField(input.full_name, "repository.full_name"),
    defaultBranch: stringField(input.default_branch, "repository.default_branch"),
  };
}

export function mapGitHubPullRequest(payload: unknown): PullRequestRead {
  const input = record(payload, "pull_request");
  const base = record(input.base, "pull_request.base");
  const head = record(input.head, "pull_request.head");

  return {
    number: integerField(input.number, "pull_request.number"),
    title: stringField(input.title, "pull_request.title"),
    state: oneOf(input.state, ["open", "closed"] as const, "pull_request.state"),
    draft: booleanField(input.draft, "pull_request.draft"),
    baseRef: stringField(base.ref, "pull_request.base.ref"),
    baseSha: stringField(base.sha, "pull_request.base.sha"),
    headRef: stringField(head.ref, "pull_request.head.ref"),
    headSha: stringField(head.sha, "pull_request.head.sha"),
    changedFiles: integerField(input.changed_files, "pull_request.changed_files"),
    htmlUrl: stringField(input.html_url, "pull_request.html_url"),
  };
}

export function mapGitHubPullRequestReview(payload: unknown): PullRequestReviewRead {
  const input = record(payload, "review");
  const actor = record(input.user, "review.user");
  const id = input.id;
  if ((typeof id !== "number" || !Number.isInteger(id)) && typeof id !== "string") {
    throw new GitHubPayloadError("review.id must be an integer or string");
  }

  return {
    id: String(id),
    state: oneOf(input.state, reviewStates, "review.state") as ReviewState,
    actor: stringField(actor.login, "review.user.login"),
    submittedAt: nullableString(input.submitted_at, "review.submitted_at"),
  };
}

export function mapGitHubCheckRun(payload: unknown): CheckRunRead {
  const input = record(payload, "check_run");
  const status = oneOf(input.status, checkStatuses, "check_run.status") as CheckRunStatus;
  let conclusion: CheckConclusion = null;
  if (input.conclusion !== null) {
    conclusion = oneOf(input.conclusion, checkConclusions, "check_run.conclusion") as CheckConclusion;
  }

  return {
    id: String(integerField(input.id, "check_run.id")),
    name: stringField(input.name, "check_run.name"),
    status,
    conclusion,
    headSha: stringField(input.head_sha, "check_run.head_sha"),
    appId: checkRunAppId(input),
    startedAt: nullableTimestamp(input.started_at, "check_run.started_at"),
    completedAt: nullableTimestamp(input.completed_at, "check_run.completed_at"),
    detailsUrl: nullableString(input.details_url, "check_run.details_url"),
  };
}

export function mapGitHubCommitStatus(payload: unknown): CommitStatusRead {
  const input = record(payload, "commit_status");
  return {
    id: String(integerField(input.id, "commit_status.id")),
    context: stringField(input.context, "commit_status.context"),
    state: oneOf(input.state, commitStatusStates, "commit_status.state") as CommitStatusState,
    headSha: stringField(input.sha, "commit_status.sha"),
    targetUrl: nullableString(input.target_url, "commit_status.target_url"),
    createdAt: timestampField(input.created_at, "commit_status.created_at"),
  };
}

export function mapGitHubWorkflowRun(payload: unknown): WorkflowRunRead {
  const input = record(payload, "workflow_run");
  return {
    id: String(integerField(input.id, "workflow_run.id")),
    workflowId: String(positiveIntegerField(input.workflow_id, "workflow_run.workflow_id")),
    runNumber: positiveIntegerField(input.run_number, "workflow_run.run_number"),
    runAttempt: positiveIntegerField(input.run_attempt, "workflow_run.run_attempt"),
    name: stringField(input.name, "workflow_run.name"),
    status: oneOf(input.status, workflowStatuses, "workflow_run.status") as WorkflowRunStatus,
    conclusion: nullableString(input.conclusion, "workflow_run.conclusion"),
    headSha: stringField(input.head_sha, "workflow_run.head_sha"),
    createdAt: timestampField(input.created_at, "workflow_run.created_at"),
    updatedAt: timestampField(input.updated_at, "workflow_run.updated_at"),
    runStartedAt: nullableTimestamp(input.run_started_at, "workflow_run.run_started_at"),
    htmlUrl: stringField(input.html_url, "workflow_run.html_url"),
  };
}

export function mapGitHubIssue(payload: unknown): IssueRead {
  const input = record(payload, "issue");
  return {
    number: integerField(input.number, "issue.number"),
    title: stringField(input.title, "issue.title"),
    state: oneOf(input.state, ["open", "closed"] as const, "issue.state"),
    htmlUrl: stringField(input.html_url, "issue.html_url"),
  };
}

export function keepLatestExactHeadCheckRuns(payloads: readonly unknown[], expectedHeadSha: string): CheckRunRead[] {
  const exactHead = payloads.map(mapGitHubCheckRun).filter((item) => item.headSha === expectedHeadSha);
  return selectLatestEffectiveCheckRuns(exactHead);
}

export function keepLatestExactHeadCommitStatuses(
  payloads: readonly unknown[],
  expectedHeadSha: string,
): CommitStatusRead[] {
  const exactHead = payloads.map(mapGitHubCommitStatus).filter((item) => item.headSha === expectedHeadSha);
  return selectLatestEffectiveCommitStatuses(exactHead);
}

export function keepLatestExactHeadWorkflowRuns(payloads: readonly unknown[], expectedHeadSha: string): WorkflowRunRead[] {
  const exactHead = payloads.map(mapGitHubWorkflowRun).filter((item) => item.headSha === expectedHeadSha);
  return selectLatestEffectiveWorkflowRuns(exactHead);
}
