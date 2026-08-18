import {
  AuthoritativeReconciliationError,
  reconcileAuthoritativePullRequestDecision,
  type AuthoritativeReconciliationRequest,
  type AuthoritativeReconciliationResult,
} from "../shared/authoritative-reconciliation.js";
import { resolveNeedsChangesProjectPolicy } from "../shared/project-policy.js";
import {
  createCloudflareGitHubReadRuntime,
  type CloudflareGitHubReadRuntime,
  type CloudflareGitHubRuntimeBindings,
} from "../integrations/github/cloudflare-worker-runtime.js";

export const GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH = "/api/github/needs-changes/preflight" as const;

const QUERY_KEYS = ["repository", "issue", "pull"] as const;
type QueryKey = (typeof QUERY_KEYS)[number];

export interface LiveGitHubNeedsChangesPreflightInput {
  readonly bindings: CloudflareGitHubRuntimeBindings;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly observedAt: string;
}

export interface LiveGitHubNeedsChangesPreflightDependencies {
  readonly createRuntime?: (bindings: CloudflareGitHubRuntimeBindings) => CloudflareGitHubReadRuntime;
  readonly reconcile?: (
    request: AuthoritativeReconciliationRequest,
  ) => Promise<AuthoritativeReconciliationResult>;
}

export type LiveGitHubNeedsChangesPreflightExecutor = (
  input: LiveGitHubNeedsChangesPreflightInput,
) => Promise<AuthoritativeReconciliationResult>;

class RouteInputError extends Error {
  constructor() {
    super("Needs changes preflight request failed validation");
    this.name = "RouteInputError";
  }
}

function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  return headers;
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(body, { status, headers: noStoreHeaders(extraHeaders) });
}

function routeError(code: string, status: number, extraHeaders?: HeadersInit): Response {
  return jsonResponse({ error: code }, status, extraHeaders);
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

function parseRequest(
  request: Request,
): Omit<LiveGitHubNeedsChangesPreflightInput, "bindings" | "observedAt"> {
  const url = new URL(request.url);
  if (url.pathname !== GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH) throw new RouteInputError();

  const presentKeys = [...url.searchParams.keys()];
  if (
    presentKeys.length !== QUERY_KEYS.length ||
    presentKeys.some((key) => !QUERY_KEYS.includes(key as QueryKey))
  ) {
    throw new RouteInputError();
  }

  const repositoryInput = exactQueryValue(url.searchParams, "repository");
  const policy = resolveNeedsChangesProjectPolicy(repositoryInput);
  if (!policy) throw new RouteInputError();

  return {
    repository: policy.repository,
    issueNumber: positiveInteger(exactQueryValue(url.searchParams, "issue")),
    pullNumber: positiveInteger(exactQueryValue(url.searchParams, "pull")),
  };
}

export async function executeLiveGitHubNeedsChangesPreflight(
  input: LiveGitHubNeedsChangesPreflightInput,
  dependencies: LiveGitHubNeedsChangesPreflightDependencies = {},
): Promise<AuthoritativeReconciliationResult> {
  const createRuntime =
    dependencies.createRuntime ??
    ((bindings: CloudflareGitHubRuntimeBindings) => createCloudflareGitHubReadRuntime({ bindings }));
  const reconcile = dependencies.reconcile ?? reconcileAuthoritativePullRequestDecision;
  const runtime = createRuntime(input.bindings);
  const context = runtime.createRepositoryNeedsChangesReadContext(input.repository, input.observedAt);

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

function mapFailure(error: unknown): Response {
  if (error instanceof RouteInputError) return routeError("INVALID_REQUEST", 400);
  if (error instanceof AuthoritativeReconciliationError) {
    if (error.code === "ISSUE_NOT_FOUND") return routeError("ISSUE_NOT_FOUND", 404);
    if (error.code === "INVALID_REQUEST") return routeError("INVALID_REQUEST", 400);
    return routeError("EVIDENCE_INVALID", 502);
  }
  return routeError("LIVE_READ_FAILED", 502);
}

export async function handleGitHubNeedsChangesPreflightRequest(
  request: Request,
  bindings: CloudflareGitHubRuntimeBindings,
  observedAt: string,
  executor: LiveGitHubNeedsChangesPreflightExecutor = executeLiveGitHubNeedsChangesPreflight,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== GITHUB_NEEDS_CHANGES_PREFLIGHT_ROUTE_PATH) return routeError("NOT_FOUND", 404);
  if (request.method !== "GET") return routeError("METHOD_NOT_ALLOWED", 405, { Allow: "GET" });

  try {
    const parsed = parseRequest(request);
    const result = await executor({ bindings, observedAt, ...parsed });
    return jsonResponse(result);
  } catch (error) {
    return mapFailure(error);
  }
}
