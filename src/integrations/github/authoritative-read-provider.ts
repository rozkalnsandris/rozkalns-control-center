import {
  keepLatestExactHeadCheckRuns,
  keepLatestExactHeadCommitStatuses,
  keepLatestExactHeadWorkflowRuns,
  mapGitHubIssue,
  mapGitHubPullRequest,
  mapGitHubPullRequestReview,
  mapGitHubRepository,
} from "../../shared/github-rest-mappers.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import {
  readAuthoritativePullRequestSnapshot,
  type AuthoritativeReadOptions,
  type ChangeRequestReadSnapshot,
  type CheckRunRead,
  type CommitStatusRead,
  type IssueRead,
  type PullRequestMergeStateRead,
  type PullRequestRead,
  type PullRequestReviewRead,
  type RepositoryRef,
  type SourceControlReadProvider,
  type WorkflowRunRead,
} from "../../shared/source-control-read.js";
import {
  createGitHubReadRequest,
  parseGitHubInstallationReadScope,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
  type Phase2GitHubReadPermission,
} from "./app-installation-read-contract.js";
import type { GitHubGraphqlMergeStateTransport } from "./graphql-merge-state-transport.js";

export type GitHubAuthoritativeReadProviderFailureCode = "INVALID_REQUEST" | "MALFORMED_RESPONSE";

const failureMessages: Readonly<Record<GitHubAuthoritativeReadProviderFailureCode, string>> = {
  INVALID_REQUEST: "GitHub authoritative read provider request failed validation",
  MALFORMED_RESPONSE: "GitHub authoritative read provider response is malformed",
};

export class GitHubAuthoritativeReadProviderError extends Error {
  readonly code: GitHubAuthoritativeReadProviderFailureCode;

  constructor(code: GitHubAuthoritativeReadProviderFailureCode) {
    super(failureMessages[code]);
    this.name = "GitHubAuthoritativeReadProviderError";
    this.code = code;
  }
}

export interface GitHubAuthoritativeReadProvider extends SourceControlReadProvider {
  readonly scope: GitHubInstallationReadScope;
  readonly observedAt: string;
}

export interface GitHubAuthoritativeReadProviderOptions {
  readonly scope: GitHubInstallationReadScope;
  readonly observedAt: string;
  readonly restTransport: GitHubInstallationReadTransport;
  readonly graphqlMergeStateTransport: GitHubGraphqlMergeStateTransport;
}

export interface GitHubAuthoritativePullRequestSnapshotOptions
  extends GitHubAuthoritativeReadProviderOptions,
    AuthoritativeReadOptions {
  readonly repository: string;
  readonly pullNumber: number;
}

type JsonRecord = Record<string, unknown>;

function malformed(): never {
  throw new GitHubAuthoritativeReadProviderError("MALFORMED_RESPONSE");
}

function requireRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  return value as JsonRecord;
}

function requireArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) malformed();
  return value;
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) malformed();
  return value;
}

function normalizeObservedAt(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new GitHubAuthoritativeReadProviderError("INVALID_REQUEST");
  }
  return value;
}

function normalizeScope(value: GitHubInstallationReadScope): GitHubInstallationReadScope {
  try {
    return parseGitHubInstallationReadScope(value);
  } catch {
    throw new GitHubAuthoritativeReadProviderError("INVALID_REQUEST");
  }
}

function canonicalRepository(repository: string): string {
  try {
    return requireManagedProjectPolicy(repository).repository;
  } catch {
    throw new GitHubAuthoritativeReadProviderError("INVALID_REQUEST");
  }
}

function positivePullNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubAuthoritativeReadProviderError("INVALID_REQUEST");
  }
  return value;
}

function safeMap<T>(mapper: (payload: unknown) => T, payload: unknown): T {
  try {
    return mapper(payload);
  } catch {
    return malformed();
  }
}

function singlePage(pages: readonly unknown[]): unknown {
  if (pages.length !== 1) malformed();
  return pages[0];
}

function flattenArrayPages(pages: readonly unknown[]): readonly unknown[] {
  const values: unknown[] = [];
  for (const page of pages) values.push(...requireArray(page));
  return values;
}

function flattenWrappedArrayPages(pages: readonly unknown[], field: string): readonly unknown[] {
  const values: unknown[] = [];
  for (const page of pages) {
    const record = requireRecord(page);
    values.push(...requireArray(record[field]));
  }
  return values;
}

function branchHeadSha(payload: unknown, expectedBranch: string): string {
  const branch = requireRecord(payload);
  if (branch.name !== expectedBranch) malformed();
  const commit = requireRecord(branch.commit);
  return requireNonEmptyString(commit.sha);
}

interface ListedOpenPullRequestIdentity {
  readonly number: number;
  readonly headSha: string;
}

function listedOpenPullRequestIdentity(payload: unknown): ListedOpenPullRequestIdentity {
  const pull = requireRecord(payload);
  if (pull.state !== "open") malformed();
  if (typeof pull.number !== "number" || !Number.isSafeInteger(pull.number) || pull.number <= 0) malformed();
  const head = requireRecord(pull.head);
  return {
    number: pull.number,
    headSha: requireNonEmptyString(head.sha),
  };
}

function assertOpenPullRequest(pullRequest: PullRequestRead): PullRequestRead {
  if (pullRequest.state !== "open") malformed();
  return pullRequest;
}

function assertOpenIssue(issue: IssueRead): IssueRead {
  if (issue.state !== "open") malformed();
  return issue;
}

export function createGitHubAuthoritativeReadProvider(
  options: GitHubAuthoritativeReadProviderOptions,
): GitHubAuthoritativeReadProvider {
  const scope = normalizeScope(options.scope);
  const observedAt = normalizeObservedAt(options.observedAt);
  const restTransport = options.restTransport;
  const graphqlMergeStateTransport = options.graphqlMergeStateTransport;

  async function restPages(
    repositoryInput: string,
    path: string,
    permission: Phase2GitHubReadPermission,
  ): Promise<readonly unknown[]> {
    const repository = canonicalRepository(repositoryInput);
    let request;
    try {
      request = createGitHubReadRequest(scope, repository, path, permission);
    } catch {
      throw new GitHubAuthoritativeReadProviderError("INVALID_REQUEST");
    }
    return (await restTransport.get<unknown>(scope, request, observedAt)).pages;
  }

  return {
    scope,
    observedAt,

    async getRepository(repositoryInput: string): Promise<RepositoryRef> {
      const repository = canonicalRepository(repositoryInput);
      const pages = await restPages(repository, `/repos/${repository}`, "metadata");
      const mapped = safeMap(mapGitHubRepository, singlePage(pages));
      if (mapped.repository.toLowerCase() !== repository.toLowerCase()) malformed();
      return mapped;
    },

    async getDefaultBranchHead(repositoryInput: string, defaultBranch: string): Promise<string> {
      const repository = canonicalRepository(repositoryInput);
      if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
        throw new GitHubAuthoritativeReadProviderError("INVALID_REQUEST");
      }
      const branch = encodeURIComponent(defaultBranch);
      const pages = await restPages(repository, `/repos/${repository}/branches/${branch}`, "contents");
      return branchHeadSha(singlePage(pages), defaultBranch);
    },

    async listOpenIssues(repositoryInput: string): Promise<IssueRead[]> {
      const repository = canonicalRepository(repositoryInput);
      const pages = await restPages(repository, `/repos/${repository}/issues?state=open&per_page=100`, "issues");
      const issues: IssueRead[] = [];
      for (const payload of flattenArrayPages(pages)) {
        const record = requireRecord(payload);
        if (Object.prototype.hasOwnProperty.call(record, "pull_request")) continue;
        issues.push(assertOpenIssue(safeMap(mapGitHubIssue, record)));
      }
      return issues;
    },

    async listOpenPullRequests(repositoryInput: string): Promise<PullRequestRead[]> {
      const repository = canonicalRepository(repositoryInput);
      const pages = await restPages(repository, `/repos/${repository}/pulls?state=open&per_page=100`, "pull_requests");
      return Promise.all(
        flattenArrayPages(pages).map(async (payload) => {
          const record = requireRecord(payload);
          if (Object.prototype.hasOwnProperty.call(record, "changed_files")) {
            return assertOpenPullRequest(safeMap(mapGitHubPullRequest, record));
          }

          const listed = listedOpenPullRequestIdentity(record);
          const detailPages = await restPages(
            repository,
            `/repos/${repository}/pulls/${listed.number}`,
            "pull_requests",
          );
          const detailed = assertOpenPullRequest(safeMap(mapGitHubPullRequest, singlePage(detailPages)));
          if (detailed.number !== listed.number || detailed.headSha !== listed.headSha) malformed();
          return detailed;
        }),
      );
    },

    async getPullRequest(repositoryInput: string, pullNumberInput: number): Promise<PullRequestRead> {
      const repository = canonicalRepository(repositoryInput);
      const pullNumber = positivePullNumber(pullNumberInput);
      const pages = await restPages(repository, `/repos/${repository}/pulls/${pullNumber}`, "pull_requests");
      const mapped = safeMap(mapGitHubPullRequest, singlePage(pages));
      if (mapped.number !== pullNumber) malformed();
      return mapped;
    },

    async getPullRequestMergeState(
      repositoryInput: string,
      pullNumberInput: number,
    ): Promise<PullRequestMergeStateRead> {
      const repository = canonicalRepository(repositoryInput);
      const pullNumber = positivePullNumber(pullNumberInput);
      return (
        await graphqlMergeStateTransport.read(scope, { repository, pullNumber }, observedAt)
      ).mergeState;
    },

    async listPullRequestReviews(
      repositoryInput: string,
      pullNumberInput: number,
    ): Promise<PullRequestReviewRead[]> {
      const repository = canonicalRepository(repositoryInput);
      const pullNumber = positivePullNumber(pullNumberInput);
      const pages = await restPages(
        repository,
        `/repos/${repository}/pulls/${pullNumber}/reviews?per_page=100`,
        "pull_requests",
      );
      return flattenArrayPages(pages).map((payload) => safeMap(mapGitHubPullRequestReview, payload));
    },

    async listCheckRuns(repositoryInput: string, headSha: string): Promise<CheckRunRead[]> {
      const repository = canonicalRepository(repositoryInput);
      const encodedHead = encodeURIComponent(requireNonEmptyString(headSha));
      const pages = await restPages(
        repository,
        `/repos/${repository}/commits/${encodedHead}/check-runs?filter=all&per_page=100`,
        "checks",
      );
      try {
        return keepLatestExactHeadCheckRuns(flattenWrappedArrayPages(pages, "check_runs"), headSha);
      } catch {
        return malformed();
      }
    },

    async listCommitStatuses(repositoryInput: string, headSha: string): Promise<CommitStatusRead[]> {
      const repository = canonicalRepository(repositoryInput);
      const encodedHead = encodeURIComponent(requireNonEmptyString(headSha));
      const pages = await restPages(
        repository,
        `/repos/${repository}/commits/${encodedHead}/statuses?per_page=100`,
        "statuses",
      );
      try {
        return keepLatestExactHeadCommitStatuses(flattenArrayPages(pages), headSha);
      } catch {
        return malformed();
      }
    },

    async listWorkflowRuns(repositoryInput: string, headSha: string): Promise<WorkflowRunRead[]> {
      const repository = canonicalRepository(repositoryInput);
      const encodedHead = encodeURIComponent(requireNonEmptyString(headSha));
      const pages = await restPages(
        repository,
        `/repos/${repository}/actions/runs?head_sha=${encodedHead}&per_page=100`,
        "actions",
      );
      try {
        return keepLatestExactHeadWorkflowRuns(flattenWrappedArrayPages(pages, "workflow_runs"), headSha);
      } catch {
        return malformed();
      }
    },
  };
}

export async function readGitHubAuthoritativePullRequestSnapshot(
  options: GitHubAuthoritativePullRequestSnapshotOptions,
): Promise<ChangeRequestReadSnapshot> {
  const provider = createGitHubAuthoritativeReadProvider(options);
  return readAuthoritativePullRequestSnapshot(
    provider,
    options.repository,
    options.pullNumber,
    provider.observedAt,
    { commitStatusCoverage: options.commitStatusCoverage },
  );
}
