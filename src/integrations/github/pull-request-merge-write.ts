import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import { GITHUB_REST_API_VERSION } from "./app-installation-read-contract.js";
import { GITHUB_REST_ACCEPT, GITHUB_REST_ORIGIN } from "./rest-read-transport.js";

export const GITHUB_CONTENTS_WRITE_PERMISSION = "contents:write" as const;
export const GITHUB_MERGE_METHODS = ["merge", "squash", "rebase"] as const;

export type GitHubMergeMethod = (typeof GITHUB_MERGE_METHODS)[number];

export type GitHubPullRequestMergeWriteFailureCode =
  | "INVALID_REQUEST"
  | "CREDENTIAL_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "MERGE_NOT_ALLOWED"
  | "HEAD_CONFLICT"
  | "RATE_LIMITED"
  | "VALIDATION_FAILED"
  | "WRITE_OUTCOME_UNKNOWN";

const failureMessages: Readonly<Record<GitHubPullRequestMergeWriteFailureCode, string>> = {
  INVALID_REQUEST: "GitHub pull-request Merge request failed validation",
  CREDENTIAL_UNAVAILABLE: "GitHub pull-request Merge credential session is unavailable",
  UNAUTHORIZED: "GitHub pull-request Merge is unauthorized",
  FORBIDDEN: "GitHub pull-request Merge is forbidden",
  NOT_FOUND: "GitHub pull-request Merge target was not found",
  MERGE_NOT_ALLOWED: "GitHub pull-request Merge is not currently allowed",
  HEAD_CONFLICT: "GitHub pull-request Merge expected head no longer matches",
  RATE_LIMITED: "GitHub pull-request Merge is rate limited",
  VALIDATION_FAILED: "GitHub pull-request Merge failed validation",
  WRITE_OUTCOME_UNKNOWN: "GitHub pull-request Merge write outcome is unknown",
};

export class GitHubPullRequestMergeWriteError extends Error {
  readonly code: GitHubPullRequestMergeWriteFailureCode;
  readonly status: number | null;

  constructor(code: GitHubPullRequestMergeWriteFailureCode, status: number | null = null) {
    super(failureMessages[code]);
    this.name = "GitHubPullRequestMergeWriteError";
    this.code = code;
    this.status = status;
  }
}

export interface GitHubPullRequestMergeWriteScope {
  readonly repository: string;
  readonly permission: typeof GITHUB_CONTENTS_WRITE_PERMISSION;
}

export interface GitHubAuthorizedRestPut {
  readonly method: "PUT";
  readonly url: string;
  readonly accept: typeof GITHUB_REST_ACCEPT;
  readonly apiVersion: typeof GITHUB_REST_API_VERSION;
  readonly contentType: "application/json";
  readonly redirect: "manual";
  readonly requiredPermission: typeof GITHUB_CONTENTS_WRITE_PERMISSION;
  readonly body: string;
}

export interface GitHubInstallationAuthorizedMergeSession {
  execute(request: GitHubAuthorizedRestPut): Promise<Response>;
}

export type GitHubInstallationAuthorizedMergeSessionProvider = (
  scope: GitHubPullRequestMergeWriteScope,
  observedAt: string,
) => Promise<GitHubInstallationAuthorizedMergeSession>;

export interface GitHubMergePullRequestWriteRequest {
  readonly repository: string;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly mergeMethod: GitHubMergeMethod;
  readonly observedAt: string;
}

export interface GitHubMergePullRequestWriteResult {
  readonly merged: true;
  readonly mergeSha: string;
}

export interface GitHubPullRequestMergeWriter {
  merge(request: GitHubMergePullRequestWriteRequest): Promise<GitHubMergePullRequestWriteResult>;
}

function normalizeRepository(value: string): string {
  try {
    return requireManagedProjectPolicy(value).repository;
  } catch {
    throw new GitHubPullRequestMergeWriteError("INVALID_REQUEST");
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubPullRequestMergeWriteError("INVALID_REQUEST");
  }
  return value;
}

function exactSha(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new GitHubPullRequestMergeWriteError("INVALID_REQUEST");
  }
  return value;
}

function mergeMethod(value: GitHubMergeMethod): GitHubMergeMethod {
  if (!(GITHUB_MERGE_METHODS as readonly string[]).includes(value)) {
    throw new GitHubPullRequestMergeWriteError("INVALID_REQUEST");
  }
  return value;
}

function observedAt(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new GitHubPullRequestMergeWriteError("INVALID_REQUEST");
  }
  return new Date(value).toISOString();
}

function endpoint(repository: string, pullNumber: number): string {
  return `${GITHUB_REST_ORIGIN}/repos/${repository}/pulls/${pullNumber}/merge`;
}

function assertJsonResponse(response: Response): void {
  const rawContentType = response.headers.get("content-type");
  if (rawContentType === null) throw new GitHubPullRequestMergeWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
  const mediaType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new GitHubPullRequestMergeWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
  }
}

function requireRecord(value: unknown, status: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubPullRequestMergeWriteError("WRITE_OUTCOME_UNKNOWN", status);
  }
  return value as Record<string, unknown>;
}

async function parseSuccess(response: Response): Promise<GitHubMergePullRequestWriteResult> {
  assertJsonResponse(response);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GitHubPullRequestMergeWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
  }

  const record = requireRecord(payload, response.status);
  if (record.merged !== true || typeof record.sha !== "string" || !/^[0-9a-f]{40}$/.test(record.sha)) {
    throw new GitHubPullRequestMergeWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
  }
  return { merged: true, mergeSha: record.sha };
}

function rejectStatus(response: Response): never {
  if (response.status === 401) throw new GitHubPullRequestMergeWriteError("UNAUTHORIZED", response.status);
  if (response.status === 403) throw new GitHubPullRequestMergeWriteError("FORBIDDEN", response.status);
  if (response.status === 404) throw new GitHubPullRequestMergeWriteError("NOT_FOUND", response.status);
  if (response.status === 405) throw new GitHubPullRequestMergeWriteError("MERGE_NOT_ALLOWED", response.status);
  if (response.status === 409) throw new GitHubPullRequestMergeWriteError("HEAD_CONFLICT", response.status);
  if (response.status === 422) throw new GitHubPullRequestMergeWriteError("VALIDATION_FAILED", response.status);
  if (response.status === 429) throw new GitHubPullRequestMergeWriteError("RATE_LIMITED", response.status);
  throw new GitHubPullRequestMergeWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
}

export function createGitHubPullRequestMergeWriter(
  acquireSession: GitHubInstallationAuthorizedMergeSessionProvider,
): GitHubPullRequestMergeWriter {
  return {
    async merge(input: GitHubMergePullRequestWriteRequest): Promise<GitHubMergePullRequestWriteResult> {
      const repository = normalizeRepository(input.repository);
      const pullNumber = positiveInteger(input.pullNumber);
      const expectedHeadSha = exactSha(input.expectedHeadSha);
      const normalizedMergeMethod = mergeMethod(input.mergeMethod);
      const normalizedObservedAt = observedAt(input.observedAt);
      const scope: GitHubPullRequestMergeWriteScope = {
        repository,
        permission: GITHUB_CONTENTS_WRITE_PERMISSION,
      };

      let session: GitHubInstallationAuthorizedMergeSession;
      try {
        session = await acquireSession(scope, normalizedObservedAt);
      } catch {
        throw new GitHubPullRequestMergeWriteError("CREDENTIAL_UNAVAILABLE");
      }

      const request: GitHubAuthorizedRestPut = {
        method: "PUT",
        url: endpoint(repository, pullNumber),
        accept: GITHUB_REST_ACCEPT,
        apiVersion: GITHUB_REST_API_VERSION,
        contentType: "application/json",
        redirect: "manual",
        requiredPermission: GITHUB_CONTENTS_WRITE_PERMISSION,
        body: JSON.stringify({ sha: expectedHeadSha, merge_method: normalizedMergeMethod }),
      };

      let response: Response;
      try {
        response = await session.execute(request);
      } catch {
        throw new GitHubPullRequestMergeWriteError("WRITE_OUTCOME_UNKNOWN");
      }

      if (response.status !== 200) rejectStatus(response);
      return parseSuccess(response);
    },
  };
}
