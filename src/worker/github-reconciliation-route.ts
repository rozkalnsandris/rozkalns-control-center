import type { AuthoritativeReconciliationRequest, AuthoritativeReconciliationResult } from "../shared/authoritative-reconciliation.js";
import {
  AuthoritativeReconciliationError,
  reconcileAuthoritativePullRequestDecision,
} from "../shared/authoritative-reconciliation.js";
import { resolveManagedProjectPolicy } from "../shared/project-policy.js";
import {
  CloudflareGitHubRuntimeError,
  createCloudflareGitHubReadRuntime,
  type CloudflareGitHubReadRuntime,
  type CloudflareGitHubRuntimeBindings,
} from "../integrations/github/cloudflare-worker-runtime.js";
import { GitHubActiveBranchRulesReaderError } from "../integrations/github/active-branch-rules-reader.js";
import { GitHubAuthoritativeReadProviderError } from "../integrations/github/authoritative-read-provider.js";
import { GitHubTransportStageDiagnosticError } from "../integrations/github/credential-stage-diagnostics.js";
import {
  GitHubGraphqlMergeStateError,
  type GitHubGraphqlMergeStateFailureCode,
} from "../integrations/github/graphql-merge-state-transport.js";
import {
  createGitHubRestConditionalCache,
  GitHubRestReadError,
  type GitHubRestReadFailureCode,
} from "../integrations/github/rest-read-transport.js";

const ROUTE_PATH = "/api/github/reconcile" as const;
const QUERY_KEYS = ["repository", "issue", "pull"] as const;

type QueryKey = (typeof QUERY_KEYS)[number];
type GitHubReadFailureCode = GitHubRestReadFailureCode | GitHubGraphqlMergeStateFailureCode;
type GitHubProjectionFailureCode = "INVALID_REQUEST" | "MALFORMED_RESPONSE";
type GitHubTransportStage = "token-exchange" | "rest" | "graphql";
type GitHubUpstreamStage = "rest" | "graphql";

const readOnlyReconciliationCache = createGitHubRestConditionalCache();

export interface LiveGitHubReconciliationInput {
  readonly bindings: CloudflareGitHubRuntimeBindings;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly observedAt: string;
}

export interface LiveGitHubReconciliationDependencies {
  readonly createRuntime?: (bindings: CloudflareGitHubRuntimeBindings) => CloudflareGitHubReadRuntime;
  readonly reconcile?: (
    request: AuthoritativeReconciliationRequest,
  ) => Promise<AuthoritativeReconciliationResult>;
}

export type LiveGitHubReconciliationExecutor = (
  input: LiveGitHubReconciliationInput,
) => Promise<AuthoritativeReconciliationResult>;

class RouteInputError extends Error {
  constructor() {
    super("GitHub reconciliation request failed validation");
    this.name = "RouteInputError";
  }
}

function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  return headers;
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: noStoreHeaders(extraHeaders),
  });
}

function routeError(code: string, status: number, extraHeaders?: HeadersInit): Response {
  return jsonResponse({ error: code }, status, extraHeaders);
}

function transportStageError(stage: GitHubTransportStage): Response {
  return jsonResponse({ error: "GITHUB_TRANSPORT_FAILED", stage }, 502);
}

function boundedHttpStatus(value: number | null): number | null {
  if (value === null || !Number.isSafeInteger(value) || value < 100 || value > 599) return null;
  return value;
}

function unexpectedStatusError(stage: GitHubUpstreamStage, status: number | null): Response {
  const upstreamStatus = boundedHttpStatus(status);
  return jsonResponse(
    upstreamStatus === null
      ? { error: "GITHUB_UNEXPECTED_STATUS", stage }
      : { error: "GITHUB_UNEXPECTED_STATUS", stage, upstreamStatus },
    502,
  );
}

function exactQueryValue(params: URLSearchParams, key: QueryKey): string {
  const values = params.getAll(key);
  if (values.length !== 1) throw new RouteInputError();
  const value = values[0];
  if (value === "" || value !== value.trim()) throw new RouteInputError();
  return value;
}

function positiveInteger(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new RouteInputError();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new RouteInputError();
  return value;
}

function parseRequest(request: Request): Omit<LiveGitHubReconciliationInput, "bindings" | "observedAt"> {
  const url = new URL(request.url);
  if (url.pathname !== ROUTE_PATH) throw new RouteInputError();

  const presentKeys = [...url.searchParams.keys()];
  if (
    presentKeys.length !== QUERY_KEYS.length ||
    presentKeys.some((key) => !QUERY_KEYS.includes(key as QueryKey))
  ) {
    throw new RouteInputError();
  }

  const repositoryInput = exactQueryValue(url.searchParams, "repository");
  const policy = resolveManagedProjectPolicy(repositoryInput);
  if (!policy) throw new RouteInputError();

  return {
    repository: policy.repository,
    issueNumber: positiveInteger(exactQueryValue(url.searchParams, "issue")),
    pullNumber: positiveInteger(exactQueryValue(url.searchParams, "pull")),
  };
}

export async function executeLiveGitHubReconciliation(
  input: LiveGitHubReconciliationInput,
  dependencies: LiveGitHubReconciliationDependencies = {},
): Promise<AuthoritativeReconciliationResult> {
  const createRuntime =
    dependencies.createRuntime ??
    ((bindings: CloudflareGitHubRuntimeBindings) =>
      createCloudflareGitHubReadRuntime({ bindings, conditionalCache: readOnlyReconciliationCache }));
  const reconcile = dependencies.reconcile ?? reconcileAuthoritativePullRequestDecision;

  const runtime = createRuntime(input.bindings);
  const context = runtime.createRepositoryReadContext(input.repository, input.observedAt, {
    purpose: "READ_ONLY_CONDITIONAL",
  });

  return reconcile({
    provider: context.provider,
    branchPolicyReader: context.branchPolicyReader,
    repository: input.repository,
    issueNumber: input.issueNumber,
    pullNumber: input.pullNumber,
    observedAt: input.observedAt,
    commitStatusCoverage: "NOT_REQUESTED",
    deployImpact: "UNKNOWN",
  });
}

function mapGitHubReadFailure(code: GitHubReadFailureCode): Response {
  switch (code) {
    case "CREDENTIAL_UNAVAILABLE":
      return routeError("GITHUB_CREDENTIAL_UNAVAILABLE", 503);
    case "CREDENTIAL_UNUSABLE":
      return routeError("GITHUB_CREDENTIAL_UNUSABLE", 503);
    case "RATE_LIMITED":
      return routeError("GITHUB_RATE_LIMITED", 503);
    case "UNAUTHORIZED":
      return routeError("GITHUB_UNAUTHORIZED", 502);
    case "FORBIDDEN":
      return routeError("GITHUB_FORBIDDEN", 502);
    case "NOT_FOUND":
    case "RESOURCE_NOT_FOUND":
      return routeError("GITHUB_RESOURCE_NOT_FOUND", 502);
    case "TRANSPORT_FAILURE":
      return routeError("GITHUB_TRANSPORT_FAILED", 502);
    case "MALFORMED_RESPONSE":
    case "PAGINATION_BOUNDARY_VIOLATION":
    case "PAGINATION_CYCLE":
    case "PAGINATION_BUDGET_EXHAUSTED":
      return routeError("GITHUB_RESPONSE_INVALID", 502);
    case "GRAPHQL_ERROR":
      return routeError("GITHUB_GRAPHQL_FAILED", 502);
    case "UNEXPECTED_STATUS":
      return routeError("GITHUB_UNEXPECTED_STATUS", 502);
    case "INVALID_REQUEST":
      return routeError("GITHUB_READ_INVALID", 502);
    default:
      return routeError("LIVE_READ_FAILED", 502);
  }
}

function mapGitHubProjectionFailure(code: GitHubProjectionFailureCode): Response {
  switch (code) {
    case "MALFORMED_RESPONSE":
      return routeError("GITHUB_RESPONSE_INVALID", 502);
    case "INVALID_REQUEST":
      return routeError("GITHUB_READ_INVALID", 502);
    default:
      return routeError("LIVE_READ_FAILED", 502);
  }
}

function mapFailure(error: unknown): Response {
  if (error instanceof RouteInputError) {
    return routeError("INVALID_REQUEST", 400);
  }

  if (error instanceof AuthoritativeReconciliationError) {
    if (error.code === "ISSUE_NOT_FOUND") return routeError("ISSUE_NOT_FOUND", 404);
    if (error.code === "INVALID_REQUEST") return routeError("INVALID_REQUEST", 400);
    return routeError("EVIDENCE_INVALID", 502);
  }

  if (error instanceof CloudflareGitHubRuntimeError) {
    return routeError("RUNTIME_UNAVAILABLE", 503);
  }

  if (error instanceof GitHubTransportStageDiagnosticError) {
    return transportStageError(error.stage);
  }

  if (error instanceof GitHubRestReadError) {
    if (error.code === "TRANSPORT_FAILURE") return transportStageError("rest");
    if (error.code === "UNEXPECTED_STATUS") return unexpectedStatusError("rest", error.status);
    return mapGitHubReadFailure(error.code);
  }

  if (error instanceof GitHubGraphqlMergeStateError) {
    if (error.code === "TRANSPORT_FAILURE") return transportStageError("graphql");
    if (error.code === "UNEXPECTED_STATUS") return unexpectedStatusError("graphql", error.status);
    return mapGitHubReadFailure(error.code);
  }

  if (
    error instanceof GitHubAuthoritativeReadProviderError ||
    error instanceof GitHubActiveBranchRulesReaderError
  ) {
    return mapGitHubProjectionFailure(error.code);
  }

  return routeError("LIVE_READ_FAILED", 502);
}

export async function handleGitHubReconciliationRequest(
  request: Request,
  bindings: CloudflareGitHubRuntimeBindings,
  observedAt: string,
  executor: LiveGitHubReconciliationExecutor = executeLiveGitHubReconciliation,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== ROUTE_PATH) return routeError("NOT_FOUND", 404);
  if (request.method !== "GET") return routeError("METHOD_NOT_ALLOWED", 405, { Allow: "GET" });

  try {
    const parsed = parseRequest(request);
    const result = await executor({
      bindings,
      observedAt,
      ...parsed,
    });
    return jsonResponse(result);
  } catch (error) {
    return mapFailure(error);
  }
}
