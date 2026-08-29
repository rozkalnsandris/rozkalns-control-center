import {
  MERGE_REQUEST_ID_PATTERN,
  MergeDecisionError,
  type MergeDecisionActor,
  type MergeDecisionRequest,
  type MergeDecisionResult,
} from "../shared/merge-decision.js";
import {
  resolveMergeProjectPolicy,
  RepositoryMergeNotAllowedError,
  type ManagedProjectPolicy,
} from "../shared/project-policy.js";
import {
  GITHUB_MERGE_METHODS,
  type GitHubMergeMethod,
} from "../integrations/github/pull-request-merge-write.js";
import { CloudflareAccessAuthenticationError } from "./access-request-authenticator.js";

export const GITHUB_MERGE_ROUTE_PATH = "/api/github/merge" as const;
export const GITHUB_MERGE_HTTP_BODY_MAX_BYTES = 4096;

const REQUEST_KEYS = [
  "expectedHeadSha",
  "expectedMainSha",
  "issueNumber",
  "mergeMethod",
  "pullNumber",
  "repository",
  "requestId",
] as const;

interface MergeRequestPayload {
  readonly requestId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly mergeMethod: GitHubMergeMethod;
}

export interface MergeRequestAuthenticator {
  authenticateRequest(request: Request): Promise<MergeDecisionActor>;
}

export interface MergeWorkerRuntime {
  readonly authenticator: MergeRequestAuthenticator;
  executeDecision(request: MergeDecisionRequest): Promise<MergeDecisionResult>;
}

export interface GitHubMergeHandlerDependencies {
  readonly resolveProject?: (repository: string) => ManagedProjectPolicy | null;
}

class MergeRouteInputError extends Error {
  constructor() {
    super("Merge request failed validation");
    this.name = "MergeRouteInputError";
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

function routeError(code: string, status: number, retryable?: false): Response {
  return jsonResponse(
    retryable === false ? { error: code, retryable: false } : { error: code },
    status,
  );
}

function assertRouteShape(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== GITHUB_MERGE_ROUTE_PATH) return routeError("NOT_FOUND", 404);
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET, POST" });
  }
  if (url.search !== "") return routeError("INVALID_REQUEST", 400);
  if (request.method === "GET") return null;

  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json") return routeError("UNSUPPORTED_MEDIA_TYPE", 415);

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength)) return routeError("INVALID_REQUEST", 400);
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > GITHUB_MERGE_HTTP_BODY_MAX_BYTES) {
      return routeError("INVALID_REQUEST", 400);
    }
  }
  return null;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new MergeRouteInputError();
  }
  return value;
}

function requireRequestId(value: unknown): string {
  const normalized = requireString(value);
  if (!MERGE_REQUEST_ID_PATTERN.test(normalized)) throw new MergeRouteInputError();
  return normalized;
}

function requirePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new MergeRouteInputError();
  return value as number;
}

function requireSha(value: unknown): string {
  const normalized = requireString(value);
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new MergeRouteInputError();
  return normalized;
}

function requireMergeMethod(value: unknown): GitHubMergeMethod {
  const normalized = requireString(value);
  if (!(GITHUB_MERGE_METHODS as readonly string[]).includes(normalized)) {
    throw new MergeRouteInputError();
  }
  return normalized as GitHubMergeMethod;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MergeRouteInputError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(REQUEST_KEYS)) {
    throw new MergeRouteInputError();
  }
  return record;
}

async function parsePayload(request: Request): Promise<MergeRequestPayload> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new MergeRouteInputError();
  }
  if (new TextEncoder().encode(text).byteLength > GITHUB_MERGE_HTTP_BODY_MAX_BYTES) {
    throw new MergeRouteInputError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MergeRouteInputError();
  }
  const record = requireRecord(parsed);
  return {
    requestId: requireRequestId(record.requestId),
    repository: requireString(record.repository),
    issueNumber: requirePositiveInteger(record.issueNumber),
    pullNumber: requirePositiveInteger(record.pullNumber),
    expectedHeadSha: requireSha(record.expectedHeadSha),
    expectedMainSha: requireSha(record.expectedMainSha),
    mergeMethod: requireMergeMethod(record.mergeMethod),
  };
}

function successProjection(result: MergeDecisionResult): Record<string, unknown> {
  return {
    status: result.status,
    requestId: result.requestId,
    repository: result.repository,
    issueNumber: result.issueNumber,
    pullNumber: result.pullNumber,
    mergeMethod: result.mergeMethod,
    expectedHeadSha: result.expectedHeadSha,
    observedHeadSha: result.observedHeadSha,
    expectedMainSha: result.expectedMainSha,
    observedMainSha: result.observedMainSha,
    observedAt: result.observedAt,
    mergeSha: result.mergeSha,
  };
}

function decisionFailure(error: MergeDecisionError): Response {
  switch (error.code) {
    case "INVALID_REQUEST":
      return routeError(error.code, 400);
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_IN_PROGRESS":
    case "POLICY_EVIDENCE_INCOMPLETE":
    case "AUTHORIZATION_STALE_HEAD":
    case "AUTHORIZATION_STALE_BASE":
    case "DECISION_NOT_READY":
      return routeError(error.code, 409);
    case "RECONCILIATION_FAILED":
    case "WRITE_REJECTED":
      return routeError(error.code, 502);
    case "WRITE_OUTCOME_UNKNOWN":
      return routeError(error.code, 502, false);
    case "AUDIT_FINALIZATION_FAILED":
      return routeError(error.code, 500, false);
    default:
      return routeError("MERGE_FAILED", 500);
  }
}

async function handleAuthDiagnostic(
  request: Request,
  runtime: MergeWorkerRuntime,
): Promise<Response> {
  try {
    await runtime.authenticator.authenticateRequest(request);
    return jsonResponse({ status: "AUTHENTICATED" });
  } catch (error) {
    if (error instanceof CloudflareAccessAuthenticationError) {
      return jsonResponse(
        {
          error: "ACCESS_AUTHENTICATION_FAILED",
          diagnostic: error.reason,
          ...(error.reason === "ACCESS_JWT_AUDIENCE_INVALID" && error.audienceDiagnostic
            ? { audience: error.audienceDiagnostic }
            : {}),
        },
        403,
      );
    }
    return routeError("ACCESS_AUTHENTICATION_FAILED", 403);
  }
}

export async function handleGitHubMergeRequest(
  request: Request,
  runtime: MergeWorkerRuntime | null,
  dependencies: GitHubMergeHandlerDependencies = {},
): Promise<Response> {
  const routeFailure = assertRouteShape(request);
  if (routeFailure) return routeFailure;
  if (runtime === null) return routeError("RUNTIME_UNAVAILABLE", 503);
  if (request.method === "GET") return handleAuthDiagnostic(request, runtime);

  let actor: MergeDecisionActor;
  try {
    actor = await runtime.authenticator.authenticateRequest(request);
  } catch {
    return routeError("ACCESS_AUTHENTICATION_FAILED", 403);
  }

  try {
    const payload = await parsePayload(request);
    const resolveProject = dependencies.resolveProject ?? resolveMergeProjectPolicy;
    const project = resolveProject(payload.repository);
    if (!project || project.canMerge !== true) {
      return routeError("ACTION_NOT_ALLOWED", 403);
    }

    const result = await runtime.executeDecision({
      ...payload,
      repository: project.repository,
      actor: { subject: actor.subject, email: actor.email },
    });
    return jsonResponse(successProjection(result));
  } catch (error) {
    if (error instanceof MergeRouteInputError) return routeError("INVALID_REQUEST", 400);
    if (error instanceof RepositoryMergeNotAllowedError) {
      return routeError("ACTION_NOT_ALLOWED", 403);
    }
    if (error instanceof MergeDecisionError) return decisionFailure(error);
    return routeError("MERGE_FAILED", 500);
  }
}
