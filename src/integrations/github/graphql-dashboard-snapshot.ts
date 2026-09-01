import {
  assertGitHubCredentialLeaseUsable,
  parseGitHubInstallationReadScope,
  type GitHubCredentialLeaseEvidence,
  type GitHubInstallationReadScope,
} from "./app-installation-read-contract.js";
import {
  GITHUB_GRAPHQL_ACCEPT,
  GITHUB_GRAPHQL_CONTENT_TYPE,
  GITHUB_GRAPHQL_ENDPOINT,
} from "./graphql-merge-state-transport.js";
import { managedProjectPolicies, requireManagedProjectPolicy } from "../../shared/project-policy.js";
import type { LiveDashboardReadContextFactory } from "../../shared/live-dashboard.js";
import type {
  CheckConclusion,
  CheckRunRead,
  CheckRunStatus,
  IssueRead,
  PullRequestMergeStateRead,
  PullRequestRead,
  PullRequestReviewRead,
  ReviewState,
  SourceControlReadProvider,
  WorkflowRunRead,
  WorkflowRunStatus,
} from "../../shared/source-control-read.js";

export const GITHUB_GRAPHQL_DASHBOARD_OPERATION = "ControlDashboardRepositorySnapshot" as const;
export const GITHUB_GRAPHQL_DASHBOARD_QUERY = `query ControlDashboardRepositorySnapshot($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef {
      name
      target {
        ... on Commit { oid }
      }
    }
    issues(states: OPEN, first: 100) {
      totalCount
      pageInfo { hasNextPage }
      nodes { number title state url }
    }
    pullRequests(states: OPEN, first: 100) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        number
        title
        state
        isDraft
        baseRefName
        baseRefOid
        headRefName
        headRefOid
        changedFiles
        url
        mergeable
        mergeStateStatus
        closingIssuesReferences(first: 2) {
          totalCount
          pageInfo { hasNextPage }
          nodes { number title state url }
        }
        latestReviews(first: 100) {
          pageInfo { hasNextPage }
          nodes { id state author { login } submittedAt }
        }
        statusCheckRollup {
          contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun {
                id
                databaseId
                name
                status
                conclusion
                startedAt
                completedAt
                detailsUrl
                checkSuite {
                  status
                  conclusion
                  app { databaseId }
                  workflowRun {
                    id
                    databaseId
                    runNumber
                    runAttempt
                    createdAt
                    updatedAt
                    url
                    workflow { databaseId name }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}` as const;

export interface GitHubDashboardGraphqlVariables {
  readonly owner: string;
  readonly name: string;
}

export interface GitHubAuthorizedDashboardGraphqlQuery {
  readonly method: "POST";
  readonly url: typeof GITHUB_GRAPHQL_ENDPOINT;
  readonly accept: typeof GITHUB_GRAPHQL_ACCEPT;
  readonly contentType: typeof GITHUB_GRAPHQL_CONTENT_TYPE;
  readonly operationName: typeof GITHUB_GRAPHQL_DASHBOARD_OPERATION;
  readonly query: typeof GITHUB_GRAPHQL_DASHBOARD_QUERY;
  readonly variables: GitHubDashboardGraphqlVariables;
  readonly redirect: "manual";
}

export interface GitHubInstallationAuthorizedDashboardGraphqlSession {
  readonly credentialLease: GitHubCredentialLeaseEvidence;
  execute(request: GitHubAuthorizedDashboardGraphqlQuery): Promise<Response>;
}

export type GitHubInstallationAuthorizedDashboardGraphqlSessionProvider = (
  scope: GitHubInstallationReadScope,
  observedAt: string,
) => Promise<GitHubInstallationAuthorizedDashboardGraphqlSession>;

export const GITHUB_DASHBOARD_FREE_SUBREQUEST_LIMIT = 50 as const;
export const GITHUB_DASHBOARD_MAX_EXTERNAL_SUBREQUESTS = 7 as const;

export class GitHubDashboardSnapshotError extends Error {
  constructor() {
    super("GitHub dashboard snapshot read failed");
    this.name = "GitHubDashboardSnapshotError";
  }
}

type JsonRecord = Record<string, unknown>;

interface PullEvidence {
  readonly pull: PullRequestRead;
  readonly mergeState: PullRequestMergeStateRead;
  readonly reviews: readonly PullRequestReviewRead[];
  readonly checks: readonly CheckRunRead[];
  readonly workflows: readonly WorkflowRunRead[];
}

interface RepositoryEvidence {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly mainSha: string;
  readonly issues: readonly IssueRead[];
  readonly pulls: readonly PullEvidence[];
}

function invalid(): never {
  throw new GitHubDashboardSnapshotError();
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as JsonRecord;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalid();
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return nonEmptyString(value);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed === 0) invalid();
  return parsed;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === null) return null;
  return positiveInteger(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

function sha(value: unknown): string {
  const parsed = nonEmptyString(value);
  if (!/^[0-9a-f]{40}$/i.test(parsed)) invalid();
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = nonEmptyString(value);
  if (!Number.isFinite(Date.parse(parsed))) invalid();
  return parsed;
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return timestamp(value);
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}

function connection(value: unknown): {
  readonly nodes: readonly unknown[];
  readonly hasNextPage: boolean;
  readonly totalCount: number | null;
} {
  const input = record(value);
  const pageInfo = record(input.pageInfo);
  const totalCount = input.totalCount === undefined ? null : integer(input.totalCount);
  return { nodes: array(input.nodes), hasNextPage: boolean(pageInfo.hasNextPage), totalCount };
}

function assertBoundedConnection(value: unknown, requireTotalCount = false): readonly unknown[] {
  const parsed = connection(value);
  if (parsed.hasNextPage) invalid();
  if (requireTotalCount && (parsed.totalCount === null || parsed.totalCount !== parsed.nodes.length)) invalid();
  return parsed.nodes;
}

const reviewStates = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"] as const;
const issueStates = ["OPEN", "CLOSED"] as const;
const mergeabilityValues = ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const;
const mergeStateValues = [
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
] as const;
const checkStatusValues = ["QUEUED", "IN_PROGRESS", "COMPLETED", "WAITING", "REQUESTED", "PENDING"] as const;
const checkConclusionValues = [
  "SUCCESS",
  "FAILURE",
  "NEUTRAL",
  "CANCELLED",
  "SKIPPED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STALE",
  "STARTUP_FAILURE",
] as const;

function normalizedCheckStatus(value: unknown): CheckRunStatus {
  return enumValue(value, checkStatusValues).toLowerCase() as CheckRunStatus;
}

function normalizedCheckConclusion(value: unknown): CheckConclusion {
  if (value === null) return null;
  return enumValue(value, checkConclusionValues).toLowerCase() as CheckConclusion;
}

function normalizedWorkflowStatus(value: unknown): WorkflowRunStatus {
  return normalizedCheckStatus(value) as WorkflowRunStatus;
}

function reviewFromNode(value: unknown): PullRequestReviewRead {
  const input = record(value);
  const author = record(input.author);
  return {
    id: nonEmptyString(input.id),
    state: enumValue(input.state, reviewStates) as ReviewState,
    actor: nonEmptyString(author.login),
    submittedAt: optionalTimestamp(input.submittedAt),
  };
}

function workflowFromCheckSuite(value: unknown, headSha: string): WorkflowRunRead | null {
  const suite = record(value);
  if (suite.workflowRun === null) return null;
  const run = record(suite.workflowRun);
  const workflow = record(run.workflow);
  const databaseId = optionalPositiveInteger(run.databaseId);
  const workflowId = optionalPositiveInteger(workflow.databaseId);
  const createdAt = timestamp(run.createdAt);
  return {
    id: databaseId === null ? nonEmptyString(run.id) : String(databaseId),
    workflowId: workflowId === null ? null : String(workflowId),
    runNumber: positiveInteger(run.runNumber),
    runAttempt: positiveInteger(run.runAttempt),
    name: nonEmptyString(workflow.name),
    status: normalizedWorkflowStatus(suite.status),
    conclusion: normalizedCheckConclusion(suite.conclusion),
    headSha,
    createdAt,
    updatedAt: timestamp(run.updatedAt),
    runStartedAt: createdAt,
    htmlUrl: nonEmptyString(run.url),
  };
}

function checkEvidenceFromRollup(
  value: unknown,
  headSha: string,
): { readonly checks: CheckRunRead[]; readonly workflows: WorkflowRunRead[] } {
  if (value === null) return { checks: [], workflows: [] };
  const rollup = record(value);
  const nodes = assertBoundedConnection(rollup.contexts);
  const checks: CheckRunRead[] = [];
  const workflowsById = new Map<string, WorkflowRunRead>();

  for (const nodeValue of nodes) {
    const node = record(nodeValue);
    if (node.__typename !== "CheckRun") continue;
    const suite = record(node.checkSuite);
    let appId: number | null = null;
    if (suite.app !== null) appId = optionalPositiveInteger(record(suite.app).databaseId);

    checks.push({
      id: node.databaseId === null ? nonEmptyString(node.id) : String(positiveInteger(node.databaseId)),
      name: nonEmptyString(node.name),
      status: normalizedCheckStatus(node.status),
      conclusion: normalizedCheckConclusion(node.conclusion),
      headSha,
      appId,
      startedAt: optionalTimestamp(node.startedAt),
      completedAt: optionalTimestamp(node.completedAt),
      detailsUrl: nullableString(node.detailsUrl),
    });

    const workflow = workflowFromCheckSuite(suite, headSha);
    if (workflow) workflowsById.set(workflow.id, workflow);
  }

  return { checks, workflows: [...workflowsById.values()] };
}

function closingIssueEvidenceFromConnection(value: unknown): NonNullable<PullRequestRead["closingIssues"]> {
  const parsed = connection(value);
  if (parsed.totalCount === null || parsed.nodes.length > 2 || parsed.totalCount < parsed.nodes.length) invalid();
  if (parsed.hasNextPage !== (parsed.totalCount > parsed.nodes.length)) invalid();
  return {
    totalCount: parsed.totalCount,
    issues: parsed.nodes.map(issueFromNode),
  };
}

function pullFromNode(value: unknown): PullEvidence {
  const input = record(value);
  if (input.state !== "OPEN") invalid();
  const headSha = sha(input.headRefOid);
  const pull: PullRequestRead = {
    number: positiveInteger(input.number),
    title: nonEmptyString(input.title),
    state: "open",
    draft: boolean(input.isDraft),
    baseRef: nonEmptyString(input.baseRefName),
    baseSha: sha(input.baseRefOid),
    headRef: nonEmptyString(input.headRefName),
    headSha,
    changedFiles: integer(input.changedFiles),
    htmlUrl: nonEmptyString(input.url),
    closingIssues: closingIssueEvidenceFromConnection(input.closingIssuesReferences),
  };
  const reviews = assertBoundedConnection(input.latestReviews).map(reviewFromNode);
  const evidence = checkEvidenceFromRollup(input.statusCheckRollup, headSha);
  return {
    pull,
    mergeState: {
      pullNumber: pull.number,
      headSha,
      mergeable: enumValue(input.mergeable, mergeabilityValues),
      mergeStateStatus: enumValue(input.mergeStateStatus, mergeStateValues),
      draft: pull.draft,
    },
    reviews,
    checks: evidence.checks,
    workflows: evidence.workflows,
  };
}

function issueFromNode(value: unknown): IssueRead {
  const input = record(value);
  const state = enumValue(input.state, issueStates);
  return {
    number: positiveInteger(input.number),
    title: nonEmptyString(input.title),
    state: state.toLowerCase() as IssueRead["state"],
    htmlUrl: nonEmptyString(input.url),
  };
}

function repositoryFromEnvelope(value: unknown, expectedRepository: string): RepositoryEvidence {
  const envelope = record(value);
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) invalid();
  if (envelope.errors !== undefined) invalid();
  const data = record(envelope.data);
  if (data.repository === null) invalid();
  const repository = record(data.repository);
  const repositoryName = nonEmptyString(repository.nameWithOwner);
  if (repositoryName.toLowerCase() !== expectedRepository.toLowerCase()) invalid();

  const defaultBranchRef = record(repository.defaultBranchRef);
  const defaultBranch = nonEmptyString(defaultBranchRef.name);
  const target = record(defaultBranchRef.target);
  const mainSha = sha(target.oid);
  const issues = assertBoundedConnection(repository.issues, true).map(issueFromNode);
  if (issues.some((issue) => issue.state !== "open")) invalid();
  const pulls = assertBoundedConnection(repository.pullRequests, true).map(pullFromNode);
  return { repository: repositoryName, defaultBranch, mainSha, issues, pulls };
}

function repositoryVariables(repository: string): GitHubDashboardGraphqlVariables {
  const canonical = requireManagedProjectPolicy(repository).repository;
  const [owner, name, extra] = canonical.split("/");
  if (!owner || !name || extra !== undefined) invalid();
  return { owner, name };
}

function jsonMediaType(response: Response): boolean {
  const raw = response.headers.get("content-type");
  if (raw === null) return false;
  const mediaType = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readRepository(
  session: GitHubInstallationAuthorizedDashboardGraphqlSession,
  repository: string,
): Promise<RepositoryEvidence> {
  const response = await session.execute({
    method: "POST",
    url: GITHUB_GRAPHQL_ENDPOINT,
    accept: GITHUB_GRAPHQL_ACCEPT,
    contentType: GITHUB_GRAPHQL_CONTENT_TYPE,
    operationName: GITHUB_GRAPHQL_DASHBOARD_OPERATION,
    query: GITHUB_GRAPHQL_DASHBOARD_QUERY,
    variables: repositoryVariables(repository),
    redirect: "manual",
  });
  if (response.status !== 200 || !jsonMediaType(response)) invalid();
  try {
    return repositoryFromEnvelope(await response.json(), repository);
  } catch (error) {
    if (error instanceof GitHubDashboardSnapshotError) throw error;
    return invalid();
  }
}

function exactSixRepositoryScope(scopeInput: GitHubInstallationReadScope): GitHubInstallationReadScope {
  let scope: GitHubInstallationReadScope;
  try {
    scope = parseGitHubInstallationReadScope(scopeInput);
  } catch {
    return invalid();
  }
  const expected = managedProjectPolicies
    .filter((policy) => policy.enabled && policy.githubReadEnabled)
    .map((policy) => policy.repository.toLowerCase())
    .sort();
  const actual = scope.repositories.map((repository) => repository.toLowerCase()).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid();
  for (const permission of ["metadata", "contents", "issues", "pull_requests", "checks", "actions"] as const) {
    if (scope.permissions[permission] !== "read") invalid();
  }
  if (scope.permissions.statuses !== undefined) invalid();
  return scope;
}

function evidenceProvider(evidence: RepositoryEvidence): SourceControlReadProvider {
  function pullByNumber(pullNumber: number): PullEvidence {
    const matches = evidence.pulls.filter((candidate) => candidate.pull.number === pullNumber);
    if (matches.length !== 1) return invalid();
    return matches[0];
  }

  function pullByHead(headSha: string): PullEvidence {
    const matches = evidence.pulls.filter((candidate) => candidate.pull.headSha === headSha);
    if (matches.length !== 1) return invalid();
    return matches[0];
  }

  return {
    async getRepository(repository) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase()) return invalid();
      return { repository: evidence.repository, defaultBranch: evidence.defaultBranch };
    },
    async getDefaultBranchHead(repository, defaultBranch) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase() || defaultBranch !== evidence.defaultBranch) {
        return invalid();
      }
      return evidence.mainSha;
    },
    async listOpenIssues(repository) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase()) return invalid();
      return [...evidence.issues];
    },
    async listOpenPullRequests(repository) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase()) return invalid();
      return evidence.pulls.map((candidate) => candidate.pull);
    },
    async getPullRequest(repository, pullNumber) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase()) return invalid();
      return pullByNumber(pullNumber).pull;
    },
    async getPullRequestMergeState(repository, pullNumber) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase()) return invalid();
      return pullByNumber(pullNumber).mergeState;
    },
    async listPullRequestReviews(repository, pullNumber) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase()) return invalid();
      return [...pullByNumber(pullNumber).reviews];
    },
    async listCheckRuns(repository, headSha) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase()) return invalid();
      return [...pullByHead(headSha).checks];
    },
    async listCommitStatuses(repository) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase()) return invalid();
      return [];
    },
    async listWorkflowRuns(repository, headSha) {
      if (repository.toLowerCase() !== evidence.repository.toLowerCase()) return invalid();
      return [...pullByHead(headSha).workflows];
    },
  };
}

export async function createGitHubDashboardReadContextFactory(options: {
  readonly scope: GitHubInstallationReadScope;
  readonly observedAt: string;
  readonly acquireSession: GitHubInstallationAuthorizedDashboardGraphqlSessionProvider;
}): Promise<LiveDashboardReadContextFactory> {
  const scope = exactSixRepositoryScope(options.scope);
  const observedAtMs = Date.parse(options.observedAt);
  if (!Number.isFinite(observedAtMs)) invalid();
  const observedAt = new Date(observedAtMs).toISOString();
  if (observedAt !== options.observedAt) invalid();
  const session = await options.acquireSession(scope, observedAt);
  try {
    assertGitHubCredentialLeaseUsable(session.credentialLease, scope, observedAt);
  } catch {
    return invalid();
  }

  const repositories = await Promise.all(scope.repositories.map((repository) => readRepository(session, repository)));
  const evidenceByRepository = new Map(
    repositories.map((evidence) => [evidence.repository.toLowerCase(), evidence] as const),
  );
  if (evidenceByRepository.size !== scope.repositories.length) invalid();

  return {
    createRepositoryReadContext(repository, requestedObservedAt) {
      if (requestedObservedAt !== observedAt) return invalid();
      const evidence = evidenceByRepository.get(repository.toLowerCase());
      if (!evidence) return invalid();
      return { provider: evidenceProvider(evidence) };
    },
  };
}
