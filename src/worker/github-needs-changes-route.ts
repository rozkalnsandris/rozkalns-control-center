import {
  NEEDS_CHANGES_REQUEST_ID_PATTERN,
  NeedsChangesDecisionError,
  type NeedsChangesActor,
  type NeedsChangesDecisionRequest,
  type NeedsChangesDecisionResult,
} from "../shared/needs-changes-decision.js";
import {
  resolveNeedsChangesProjectPolicy,
  RepositoryNeedsChangesNotAllowedError,
  type ManagedProjectPolicy,
} from "../shared/project-policy.js";
import { GITHUB_REVIEW_BODY_MAX_BYTES } from "../integrations/github/pull-request-review-write.js";

export const GITHUB_NEEDS_CHANGES_ROUTE_PATH = "/api/github/needs-changes" as const;
export const GITHUB_NEEDS_CHANGES_HTTP_BODY_MAX_BYTES = 8192;

const REQUEST_KEYS = [
  "body",
  "expectedHeadSha",
  "expectedMainSha",
  "issueNumber",
  "pullNumber",
  "repository",
  "requestId",
] as const;

interface NeedsChangesRequestPayload {
  readonly requestId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedMainSha: string;
  readonly body: string;
}

export interface NeedsChangesRequestAuthenticator {
  authenticateRequest(request: Request): Promise<NeedsChangesActor>;
}

export interface NeedsChangesWorkerRuntime {
  readonly authenticator: NeedsChangesRequestAuthenticator;
  executeDecision(request: NeedsChangesDecisionRequest): Promise<NeedsChangesDecisionResult>;
}

export interface GitHubNeedsChangesHandlerDependencies {
  readonly resolveProject?: (repository: string) => ManagedProjectPolicy | null;
}

class NeedsChangesRouteInputError extends Error {
  constructor() {
    super("Needs changes request failed validation");
    this.name = "NeedsChangesRouteInputError";
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
  if (url.pathname !== GITHUB_NEEDS_CHANGES_ROUTE_PATH) return routeError("NOT_FOUND", 404);
  if (request.method !== "POST") {
    return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
  }
  if (url.search !== "") return routeError("INVALID_REQUEST", 400);

  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json") return routeError("UNSUPPORTED_MEDIA_TYPE", 415);

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength)) return routeError("INVALID_REQUEST", 400);
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > GITHUB_NEEDS_CHANGES_HTTP_BODY_MAX_BYTES) {
      return routeError("INVALID_REQUEST", 400);
    }
  }
  return null;
}

function hasForbiddenControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 127;
  });
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new NeedsChangesRouteInputError();
  }
  return value;
}

function requireRequestId(value: unknown): string {
  const normalized = requireString(value);
  if (!NEEDS_CHANGES_REQUEST_ID_PATTERN.test(normalized)) throw new NeedsChangesRouteInputError();
  return normalized;
}

function requirePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new NeedsChangesRouteInputError();
  return value as number;
}

function requireSha(value: unknown): string {
  const normalized = requireString(value);
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new NeedsChangesRouteInputError();
  return normalized;
}

function requireReviewBody(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    hasForbiddenControlCharacters(value) ||
    new TextEncoder().encode(value).byteLength > GITHUB_REVIEW_BODY_MAX_BYTES
  ) {
    throw new NeedsChangesRouteInputError();
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NeedsChangesRouteInputError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(REQUEST_KEYS)) {
    throw new NeedsChangesRouteInputError();
  }
  return record;
}

async function parsePayload(request: Request): Promise<NeedsChangesRequestPayload> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new NeedsChangesRouteInputError();
  }
  if (new TextEncoder().encode(text).byteLength > GITHUB_NEEDS_CHANGES_HTTP_BODY_MAX_BYTES) {
    throw new NeedsChangesRouteInputError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NeedsChangesRouteInputError();
  }
  const record = requireRecord(parsed);
  return {
    requestId: requireRequestId(record.requestId),
    repository: requireString(record.repository),
    issueNumber: requirePositiveInteger(record.issueNumber),
    pullNumber: requirePositiveInteger(record.pullNumber),
    expectedHeadSha: requireSha(record.expectedHeadSha),
    expectedMainSha: requireSha(record.expectedMainSha),
    body: requireReviewBody(record.body),
  };
}

function successProjection(result: NeedsChangesDecisionResult): Record<string, unknown> {
  return {
    status: result.status,
    requestId: result.requestId,
    repository: result.repository,
    issueNumber: result.issueNumber,
    pullNumber: result.pullNumber,
    expectedHeadSha: result.expectedHeadSha,
    observedHeadSha: result.observedHeadSha,
    expectedMainSha: result.expectedMainSha,
    observedMainSha: result.observedMainSha,
    observedAt: result.observedAt,
    reviewId: result.reviewId,
    reviewUrl: result.reviewUrl,
    submittedAt: result.submittedAt,
  };
}

function decisionFailure(error: NeedsChangesDecisionError): Response {
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
      return routeError("NEEDS_CHANGES_FAILED", 500);
  }
}

export async function handleGitHubNeedsChangesRequest(
  request: Request,
  runtime: NeedsChangesWorkerRuntime | null,
  dependencies: GitHubNeedsChangesHandlerDependencies = {},
): Promise<Response> {
  const routeFailure = assertRouteShape(request);
  if (routeFailure) return routeFailure;
  if (runtime === null) return routeError("RUNTIME_UNAVAILABLE", 503);

  let actor: NeedsChangesActor;
  try {
    actor = await runtime.authenticator.authenticateRequest(request);
  } catch {
    return routeError("ACCESS_AUTHENTICATION_FAILED", 403);
  }

  try {
    const payload = await parsePayload(request);
    const resolveProject = dependencies.resolveProject ?? resolveNeedsChangesProjectPolicy;
    const project = resolveProject(payload.repository);
    if (!project || project.canRequestChanges !== true) {
      return routeError("ACTION_NOT_ALLOWED", 403);
    }

    const result = await runtime.executeDecision({
      ...payload,
      repository: project.repository,
      actor: { subject: actor.subject, email: actor.email },
    });
    return jsonResponse(successProjection(result));
  } catch (error) {
    if (error instanceof NeedsChangesRouteInputError) return routeError("INVALID_REQUEST", 400);
    if (error instanceof RepositoryNeedsChangesNotAllowedError) {
      return routeError("ACTION_NOT_ALLOWED", 403);
    }
    if (error instanceof NeedsChangesDecisionError) return decisionFailure(error);
    return routeError("NEEDS_CHANGES_FAILED", 500);
  }
}
