import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import { mapGitHubGraphqlPullRequestMergeState } from "../../shared/github-graphql-mappers.js";
import type { PullRequestMergeStateRead } from "../../shared/source-control-read.js";
import {
  assertGitHubCredentialLeaseUsable,
  parseGitHubInstallationReadScope,
  type GitHubCredentialLeaseEvidence,
  type GitHubInstallationReadScope,
  type GitHubRateLimitEvidence,
} from "./app-installation-read-contract.js";

export const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql" as const;
export const GITHUB_GRAPHQL_CONTENT_TYPE = "application/json" as const;
export const GITHUB_GRAPHQL_ACCEPT = "application/json" as const;
export const GITHUB_GRAPHQL_MERGE_STATE_OPERATION = "ControlPullRequestMergeState" as const;
export const GITHUB_GRAPHQL_MERGE_STATE_QUERY = `query ControlPullRequestMergeState($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      headRefOid
      mergeable
      mergeStateStatus
      isDraft
    }
  }
}` as const;

export interface GitHubGraphqlMergeStateVariables {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

export interface GitHubAuthorizedGraphqlMergeStateQuery {
  readonly method: "POST";
  readonly url: typeof GITHUB_GRAPHQL_ENDPOINT;
  readonly accept: typeof GITHUB_GRAPHQL_ACCEPT;
  readonly contentType: typeof GITHUB_GRAPHQL_CONTENT_TYPE;
  readonly operationName: typeof GITHUB_GRAPHQL_MERGE_STATE_OPERATION;
  readonly query: typeof GITHUB_GRAPHQL_MERGE_STATE_QUERY;
  readonly variables: GitHubGraphqlMergeStateVariables;
  readonly redirect: "manual";
}

export interface GitHubInstallationAuthorizedGraphqlQuerySession {
  readonly credentialLease: GitHubCredentialLeaseEvidence;
  execute(request: GitHubAuthorizedGraphqlMergeStateQuery): Promise<Response>;
}

export type GitHubInstallationAuthorizedGraphqlQuerySessionProvider = (
  scope: GitHubInstallationReadScope,
  observedAt: string,
) => Promise<GitHubInstallationAuthorizedGraphqlQuerySession>;

export interface GitHubGraphqlMergeStateRequest {
  readonly repository: string;
  readonly pullNumber: number;
}

export interface GitHubGraphqlMergeStateResult {
  readonly mergeState: PullRequestMergeStateRead;
  readonly credentialLease: GitHubCredentialLeaseEvidence;
  readonly rateLimit: GitHubRateLimitEvidence | null;
}

export interface GitHubGraphqlMergeStateTransport {
  read(
    scope: GitHubInstallationReadScope,
    request: GitHubGraphqlMergeStateRequest,
    observedAt: string,
  ): Promise<GitHubGraphqlMergeStateResult>;
}

export type GitHubGraphqlMergeStateFailureCode =
  | "INVALID_REQUEST"
  | "CREDENTIAL_UNAVAILABLE"
  | "CREDENTIAL_UNUSABLE"
  | "TRANSPORT_FAILURE"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "GRAPHQL_ERROR"
  | "RESOURCE_NOT_FOUND"
  | "MALFORMED_RESPONSE"
  | "UNEXPECTED_STATUS";

const failureMessages: Readonly<Record<GitHubGraphqlMergeStateFailureCode, string>> = {
  INVALID_REQUEST: "GitHub GraphQL merge-state request failed validation",
  CREDENTIAL_UNAVAILABLE: "GitHub GraphQL merge-state credential session is unavailable",
  CREDENTIAL_UNUSABLE: "GitHub GraphQL merge-state credential lease is unusable",
  TRANSPORT_FAILURE: "GitHub GraphQL merge-state transport failed",
  RATE_LIMITED: "GitHub GraphQL merge-state read is rate limited",
  UNAUTHORIZED: "GitHub GraphQL merge-state read is unauthorized",
  FORBIDDEN: "GitHub GraphQL merge-state read is forbidden",
  GRAPHQL_ERROR: "GitHub GraphQL merge-state query returned an error",
  RESOURCE_NOT_FOUND: "GitHub GraphQL merge-state resource was not found",
  MALFORMED_RESPONSE: "GitHub GraphQL merge-state response is malformed",
  UNEXPECTED_STATUS: "GitHub GraphQL merge-state read returned an unexpected HTTP status",
};

export class GitHubGraphqlMergeStateError extends Error {
  readonly code: GitHubGraphqlMergeStateFailureCode;
  readonly status: number | null;
  readonly retryNotBefore: string | null;
  readonly rateLimit: GitHubRateLimitEvidence | null;

  constructor(
    code: GitHubGraphqlMergeStateFailureCode,
    options: {
      status?: number | null;
      retryNotBefore?: string | null;
      rateLimit?: GitHubRateLimitEvidence | null;
    } = {},
  ) {
    super(failureMessages[code]);
    this.name = "GitHubGraphqlMergeStateError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryNotBefore = options.retryNotBefore ?? null;
    this.rateLimit = options.rateLimit ?? null;
  }
}

function parseObservedAt(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new GitHubGraphqlMergeStateError("INVALID_REQUEST");
  return parsed;
}

function normalizeRequest(
  scope: GitHubInstallationReadScope,
  request: GitHubGraphqlMergeStateRequest,
): { readonly repository: string; readonly variables: GitHubGraphqlMergeStateVariables } {
  if (!Number.isSafeInteger(request.pullNumber) || request.pullNumber <= 0) {
    throw new GitHubGraphqlMergeStateError("INVALID_REQUEST");
  }

  let policy;
  try {
    policy = requireManagedProjectPolicy(request.repository);
  } catch {
    throw new GitHubGraphqlMergeStateError("INVALID_REQUEST");
  }

  if (!scope.repositories.some((candidate) => candidate.toLowerCase() === policy.repository.toLowerCase())) {
    throw new GitHubGraphqlMergeStateError("INVALID_REQUEST");
  }
  if (scope.permissions.pull_requests !== "read") {
    throw new GitHubGraphqlMergeStateError("INVALID_REQUEST");
  }

  const [owner, name, extra] = policy.repository.split("/");
  if (!owner || !name || extra !== undefined) throw new GitHubGraphqlMergeStateError("INVALID_REQUEST");

  return {
    repository: policy.repository,
    variables: { owner, name, number: request.pullNumber },
  };
}

function optionalHeaderInteger(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  return parsed;
}

function epochSecondsToIso(value: number): string {
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  return date.toISOString();
}

function parseRateLimitEvidence(headers: Headers): GitHubRateLimitEvidence | null {
  const limit = optionalHeaderInteger(headers, "x-ratelimit-limit");
  const remaining = optionalHeaderInteger(headers, "x-ratelimit-remaining");
  const used = optionalHeaderInteger(headers, "x-ratelimit-used");
  const reset = optionalHeaderInteger(headers, "x-ratelimit-reset");
  const rawResource = headers.get("x-ratelimit-resource");

  let resource: string | null = null;
  if (rawResource !== null) {
    const trimmed = rawResource.trim();
    if (trimmed !== "graphql") throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
    resource = trimmed;
  }

  if (limit === null && remaining === null && used === null && reset === null && resource === null) return null;
  if (limit !== null && remaining !== null && remaining > limit) {
    throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  }
  if (limit !== null && used !== null && used > limit) {
    throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  }

  return {
    limit,
    remaining,
    used,
    resetAt: reset === null ? null : epochSecondsToIso(reset),
    resource,
  };
}

function parseRetryAfter(headers: Headers, observedAtMs: number): string | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds)) throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  const date = new Date(observedAtMs + seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  return date.toISOString();
}

function rateLimitedError(
  response: Response,
  observedAtMs: number,
  rateLimit: GitHubRateLimitEvidence | null,
): GitHubGraphqlMergeStateError | null {
  const retryAfter = parseRetryAfter(response.headers, observedAtMs);
  if (retryAfter !== null) {
    return new GitHubGraphqlMergeStateError("RATE_LIMITED", {
      status: response.status,
      retryNotBefore: retryAfter,
      rateLimit,
    });
  }

  if (rateLimit?.remaining === 0) {
    if (rateLimit.resetAt === null) {
      throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE", { status: response.status, rateLimit });
    }
    return new GitHubGraphqlMergeStateError("RATE_LIMITED", {
      status: response.status,
      retryNotBefore: rateLimit.resetAt,
      rateLimit,
    });
  }

  if (response.status === 429) {
    return new GitHubGraphqlMergeStateError("RATE_LIMITED", {
      status: response.status,
      retryNotBefore: new Date(observedAtMs + 60_000).toISOString(),
      rateLimit,
    });
  }

  return null;
}

function assertHttpStatus(
  response: Response,
  observedAtMs: number,
  rateLimit: GitHubRateLimitEvidence | null,
): void {
  const limited = rateLimitedError(response, observedAtMs, rateLimit);
  if (limited) throw limited;
  if (response.status === 200) return;
  if (response.status === 401) {
    throw new GitHubGraphqlMergeStateError("UNAUTHORIZED", { status: response.status, rateLimit });
  }
  if (response.status === 403) {
    throw new GitHubGraphqlMergeStateError("FORBIDDEN", { status: response.status, rateLimit });
  }
  throw new GitHubGraphqlMergeStateError("UNEXPECTED_STATUS", { status: response.status, rateLimit });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  }
  return value as Record<string, unknown>;
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  const rawContentType = response.headers.get("content-type");
  if (rawContentType === null) {
    throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE", { status: response.status });
  }
  const mediaType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE", { status: response.status });
  }

  try {
    return requireRecord(await response.json());
  } catch (error) {
    if (error instanceof GitHubGraphqlMergeStateError) throw error;
    throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE", { status: response.status });
  }
}

function hasGraphqlErrors(envelope: Record<string, unknown>): boolean {
  if (!("errors" in envelope)) return false;
  if (!Array.isArray(envelope.errors) || envelope.errors.length === 0) {
    throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  }
  return true;
}

function mapMergeStateEnvelope(
  envelope: Record<string, unknown>,
  expectedPullNumber: number,
): PullRequestMergeStateRead {
  const data = requireRecord(envelope.data);
  if (data.repository === null) throw new GitHubGraphqlMergeStateError("RESOURCE_NOT_FOUND");
  const repository = requireRecord(data.repository);
  if (repository.pullRequest === null) throw new GitHubGraphqlMergeStateError("RESOURCE_NOT_FOUND");
  const pullRequest = requireRecord(repository.pullRequest);

  let mapped: PullRequestMergeStateRead;
  try {
    mapped = mapGitHubGraphqlPullRequestMergeState(pullRequest);
  } catch {
    throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  }
  if (mapped.pullNumber !== expectedPullNumber) {
    throw new GitHubGraphqlMergeStateError("MALFORMED_RESPONSE");
  }
  return mapped;
}

export function createGitHubGraphqlMergeStateTransport(
  acquireSession: GitHubInstallationAuthorizedGraphqlQuerySessionProvider,
): GitHubGraphqlMergeStateTransport {
  return {
    async read(
      scopeInput: GitHubInstallationReadScope,
      requestInput: GitHubGraphqlMergeStateRequest,
      observedAt: string,
    ): Promise<GitHubGraphqlMergeStateResult> {
      const observedAtMs = parseObservedAt(observedAt);

      let scope: GitHubInstallationReadScope;
      try {
        scope = parseGitHubInstallationReadScope(scopeInput);
      } catch {
        throw new GitHubGraphqlMergeStateError("INVALID_REQUEST");
      }
      const request = normalizeRequest(scope, requestInput);

      let session: GitHubInstallationAuthorizedGraphqlQuerySession;
      try {
        session = await acquireSession(scope, observedAt);
      } catch {
        throw new GitHubGraphqlMergeStateError("CREDENTIAL_UNAVAILABLE");
      }
      try {
        assertGitHubCredentialLeaseUsable(session.credentialLease, scope, observedAt);
      } catch {
        throw new GitHubGraphqlMergeStateError("CREDENTIAL_UNUSABLE");
      }

      let response: Response;
      try {
        response = await session.execute({
          method: "POST",
          url: GITHUB_GRAPHQL_ENDPOINT,
          accept: GITHUB_GRAPHQL_ACCEPT,
          contentType: GITHUB_GRAPHQL_CONTENT_TYPE,
          operationName: GITHUB_GRAPHQL_MERGE_STATE_OPERATION,
          query: GITHUB_GRAPHQL_MERGE_STATE_QUERY,
          variables: request.variables,
          redirect: "manual",
        });
      } catch {
        throw new GitHubGraphqlMergeStateError("TRANSPORT_FAILURE");
      }

      const rateLimit = parseRateLimitEvidence(response.headers);
      assertHttpStatus(response, observedAtMs, rateLimit);
      const envelope = await parseJson(response);

      if (hasGraphqlErrors(envelope)) {
        const limited = rateLimitedError(response, observedAtMs, rateLimit);
        if (limited) throw limited;
        throw new GitHubGraphqlMergeStateError("GRAPHQL_ERROR", { status: response.status, rateLimit });
      }

      return {
        mergeState: mapMergeStateEnvelope(envelope, request.variables.number),
        credentialLease: session.credentialLease,
        rateLimit,
      };
    },
  };
}
