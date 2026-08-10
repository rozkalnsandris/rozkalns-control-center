import type {
  CheckConclusion,
  CheckRunRead,
  CheckRunStatus,
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

function integerField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new GitHubPayloadError(`${field} must be a non-negative integer`);
  }
  return value;
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
const workflowStatuses = ["queued", "in_progress", "completed", "waiting", "requested", "pending"] as const;

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
    detailsUrl: nullableString(input.details_url, "check_run.details_url"),
  };
}

export function mapGitHubWorkflowRun(payload: unknown): WorkflowRunRead {
  const input = record(payload, "workflow_run");
  return {
    id: String(integerField(input.id, "workflow_run.id")),
    name: stringField(input.name, "workflow_run.name"),
    status: oneOf(input.status, workflowStatuses, "workflow_run.status") as WorkflowRunStatus,
    conclusion: nullableString(input.conclusion, "workflow_run.conclusion"),
    headSha: stringField(input.head_sha, "workflow_run.head_sha"),
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

export function keepExactHeadCheckRuns(payloads: readonly unknown[], expectedHeadSha: string): CheckRunRead[] {
  return payloads.map(mapGitHubCheckRun).filter((item) => item.headSha === expectedHeadSha);
}

export function keepExactHeadWorkflowRuns(payloads: readonly unknown[], expectedHeadSha: string): WorkflowRunRead[] {
  return payloads.map(mapGitHubWorkflowRun).filter((item) => item.headSha === expectedHeadSha);
}
