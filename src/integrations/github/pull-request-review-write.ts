import { GITHUB_REST_API_VERSION } from "./app-installation-read-contract.js";
import { GITHUB_REST_ACCEPT, GITHUB_REST_ORIGIN } from "./rest-read-transport.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";

export const GITHUB_PULL_REQUESTS_WRITE_PERMISSION = "pull_requests:write" as const;
export const GITHUB_REQUEST_CHANGES_EVENT = "REQUEST_CHANGES" as const;
export const GITHUB_REVIEW_BODY_MAX_BYTES = 4096;

export type GitHubPullRequestReviewWriteFailureCode =
  | "INVALID_REQUEST"
  | "CREDENTIAL_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "VALIDATION_FAILED"
  | "WRITE_OUTCOME_UNKNOWN";

const failureMessages: Readonly<Record<GitHubPullRequestReviewWriteFailureCode, string>> = {
  INVALID_REQUEST: "GitHub pull-request review write request failed validation",
  CREDENTIAL_UNAVAILABLE: "GitHub pull-request review write credential session is unavailable",
  UNAUTHORIZED: "GitHub pull-request review write is unauthorized",
  FORBIDDEN: "GitHub pull-request review write is forbidden",
  NOT_FOUND: "GitHub pull-request review target was not found",
  RATE_LIMITED: "GitHub pull-request review write is rate limited",
  VALIDATION_FAILED: "GitHub pull-request review write failed validation",
  WRITE_OUTCOME_UNKNOWN: "GitHub pull-request review write outcome is unknown",
};

export class GitHubPullRequestReviewWriteError extends Error {
  readonly code: GitHubPullRequestReviewWriteFailureCode;
  readonly status: number | null;

  constructor(code: GitHubPullRequestReviewWriteFailureCode, status: number | null = null) {
    super(failureMessages[code]);
    this.name = "GitHubPullRequestReviewWriteError";
    this.code = code;
    this.status = status;
  }
}

export interface GitHubPullRequestWriteScope {
  readonly repository: string;
  readonly permission: typeof GITHUB_PULL_REQUESTS_WRITE_PERMISSION;
}

export interface GitHubAuthorizedRestPost {
  readonly method: "POST";
  readonly url: string;
  readonly accept: typeof GITHUB_REST_ACCEPT;
  readonly apiVersion: typeof GITHUB_REST_API_VERSION;
  readonly contentType: "application/json";
  readonly redirect: "manual";
  readonly requiredPermission: typeof GITHUB_PULL_REQUESTS_WRITE_PERMISSION;
  readonly body: string;
}

export interface GitHubInstallationAuthorizedPullRequestWriteSession {
  execute(request: GitHubAuthorizedRestPost): Promise<Response>;
}

export type GitHubInstallationAuthorizedPullRequestWriteSessionProvider = (
  scope: GitHubPullRequestWriteScope,
  observedAt: string,
) => Promise<GitHubInstallationAuthorizedPullRequestWriteSession>;

export interface GitHubRequestChangesWriteRequest {
  readonly repository: string;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly body: string;
  readonly observedAt: string;
}

export interface GitHubRequestChangesWriteResult {
  readonly reviewId: string;
  readonly state: "CHANGES_REQUESTED";
  readonly commitId: string;
  readonly htmlUrl: string;
  readonly submittedAt: string;
}

export interface GitHubPullRequestReviewWriter {
  requestChanges(request: GitHubRequestChangesWriteRequest): Promise<GitHubRequestChangesWriteResult>;
}

function hasControlCharacterExceptWhitespace(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 127;
  });
}

function normalizeRepository(value: string): string {
  try {
    return requireManagedProjectPolicy(value).repository;
  } catch {
    throw new GitHubPullRequestReviewWriteError("INVALID_REQUEST");
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubPullRequestReviewWriteError("INVALID_REQUEST");
  }
  return value;
}

function exactSha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new GitHubPullRequestReviewWriteError("INVALID_REQUEST");
  }
  return value;
}

function boundedBody(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || hasControlCharacterExceptWhitespace(value)) {
    throw new GitHubPullRequestReviewWriteError("INVALID_REQUEST");
  }
  if (new TextEncoder().encode(value).byteLength > GITHUB_REVIEW_BODY_MAX_BYTES) {
    throw new GitHubPullRequestReviewWriteError("INVALID_REQUEST");
  }
  return value;
}

function observedAt(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new GitHubPullRequestReviewWriteError("INVALID_REQUEST");
  }
  return new Date(value).toISOString();
}

function endpoint(repository: string, pullNumber: number): string {
  return `${GITHUB_REST_ORIGIN}/repos/${repository}/pulls/${pullNumber}/reviews`;
}

function assertJsonResponse(response: Response): void {
  const rawContentType = response.headers.get("content-type");
  if (rawContentType === null) throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
  const mediaType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
  }
}

function requireRecord(value: unknown, status: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", status);
  }
  return value as Record<string, unknown>;
}

function parseReviewId(value: unknown, status: number): string {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", status);
  }
  return String(value);
}

function parseSubmittedAt(value: unknown, status: number): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", status);
  }
  return new Date(value).toISOString();
}

function parseReviewUrl(value: unknown, repository: string, pullNumber: number, status: number): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", status);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", status);
  }

  const expectedPath = `/${repository}/pull/${pullNumber}`.toLowerCase();
  if (
    url.origin !== "https://github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.pathname.toLowerCase() !== expectedPath ||
    !/^#pullrequestreview-[1-9][0-9]*$/.test(url.hash)
  ) {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", status);
  }

  return url.toString();
}

async function parseSuccess(
  response: Response,
  repository: string,
  pullNumber: number,
  expectedHeadSha: string,
): Promise<GitHubRequestChangesWriteResult> {
  assertJsonResponse(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
  }

  const record = requireRecord(payload, response.status);
  if (record.state !== "CHANGES_REQUESTED" || record.commit_id !== expectedHeadSha) {
    throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
  }

  return {
    reviewId: parseReviewId(record.id, response.status),
    state: "CHANGES_REQUESTED",
    commitId: expectedHeadSha,
    htmlUrl: parseReviewUrl(record.html_url, repository, pullNumber, response.status),
    submittedAt: parseSubmittedAt(record.submitted_at, response.status),
  };
}

function rejectStatus(response: Response): never {
  if (response.status === 401) throw new GitHubPullRequestReviewWriteError("UNAUTHORIZED", response.status);
  if (response.status === 403) throw new GitHubPullRequestReviewWriteError("FORBIDDEN", response.status);
  if (response.status === 404) throw new GitHubPullRequestReviewWriteError("NOT_FOUND", response.status);
  if (response.status === 429) throw new GitHubPullRequestReviewWriteError("RATE_LIMITED", response.status);
  if (response.status === 422) throw new GitHubPullRequestReviewWriteError("VALIDATION_FAILED", response.status);
  throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN", response.status);
}

export function createGitHubPullRequestReviewWriter(
  acquireSession: GitHubInstallationAuthorizedPullRequestWriteSessionProvider,
): GitHubPullRequestReviewWriter {
  return {
    async requestChanges(input: GitHubRequestChangesWriteRequest): Promise<GitHubRequestChangesWriteResult> {
      const repository = normalizeRepository(input.repository);
      const pullNumber = positiveInteger(input.pullNumber);
      const expectedHeadSha = exactSha(input.expectedHeadSha);
      const body = boundedBody(input.body);
      const normalizedObservedAt = observedAt(input.observedAt);
      const scope: GitHubPullRequestWriteScope = {
        repository,
        permission: GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
      };

      let session: GitHubInstallationAuthorizedPullRequestWriteSession;
      try {
        session = await acquireSession(scope, normalizedObservedAt);
      } catch {
        throw new GitHubPullRequestReviewWriteError("CREDENTIAL_UNAVAILABLE");
      }

      const request: GitHubAuthorizedRestPost = {
        method: "POST",
        url: endpoint(repository, pullNumber),
        accept: GITHUB_REST_ACCEPT,
        apiVersion: GITHUB_REST_API_VERSION,
        contentType: "application/json",
        redirect: "manual",
        requiredPermission: GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
        body: JSON.stringify({
          commit_id: expectedHeadSha,
          body,
          event: GITHUB_REQUEST_CHANGES_EVENT,
        }),
      };

      let response: Response;
      try {
        response = await session.execute(request);
      } catch {
        throw new GitHubPullRequestReviewWriteError("WRITE_OUTCOME_UNKNOWN");
      }

      if (response.status !== 200) rejectStatus(response);
      return parseSuccess(response, repository, pullNumber, expectedHeadSha);
    },
  };
}
