import {
  LaterActionError,
  type LaterActionRequest,
  type LaterActionResult,
} from "../shared/later-action.js";
import type { LaterDecisionActor } from "../shared/later-deferral-store.js";
import {
  RepositoryLaterNotAllowedError,
  resolveLaterProjectPolicy,
  type ManagedProjectPolicy,
} from "../shared/project-policy.js";

export const GITHUB_LATER_ROUTE_PATH = "/api/github/later" as const;
export const GITHUB_LATER_HTTP_BODY_MAX_BYTES = 2048;

const REQUEST_KEYS = ["decisionId", "expectedStateFingerprint", "repository"] as const;
const FINGERPRINT_PATTERN = /^later-v1-[0-9a-f]{16}$/;
const IDENTIFIER_LIMIT = 256;

interface LaterRequestPayload {
  readonly repository: string;
  readonly decisionId: string;
  readonly expectedStateFingerprint: string;
}

export interface LaterRequestAuthenticator {
  authenticateRequest(request: Request): Promise<LaterDecisionActor>;
}

export interface LaterWorkerRuntime {
  readonly authenticator: LaterRequestAuthenticator;
  executeDecision(request: Omit<LaterActionRequest, "projectId">): Promise<LaterActionResult>;
}

export interface GitHubLaterHandlerDependencies {
  readonly resolveProject?: (repository: string) => ManagedProjectPolicy | null;
}

class LaterRouteInputError extends Error {
  constructor() {
    super("Later request failed validation");
    this.name = "LaterRouteInputError";
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

function routeError(code: string, status: number): Response {
  return jsonResponse({ error: code }, status);
}

function assertRouteShape(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== GITHUB_LATER_ROUTE_PATH) return routeError("NOT_FOUND", 404);
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
    if (!Number.isSafeInteger(length) || length > GITHUB_LATER_HTTP_BODY_MAX_BYTES) {
      return routeError("INVALID_REQUEST", 400);
    }
  }
  return null;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_LIMIT ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new LaterRouteInputError();
  }
  return value;
}

function requireFingerprint(value: unknown): string {
  const normalized = requireIdentifier(value);
  if (!FINGERPRINT_PATTERN.test(normalized)) throw new LaterRouteInputError();
  return normalized;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaterRouteInputError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(REQUEST_KEYS)) {
    throw new LaterRouteInputError();
  }
  return record;
}

async function parsePayload(request: Request): Promise<LaterRequestPayload> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new LaterRouteInputError();
  }
  if (new TextEncoder().encode(text).byteLength > GITHUB_LATER_HTTP_BODY_MAX_BYTES) {
    throw new LaterRouteInputError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LaterRouteInputError();
  }
  const record = requireRecord(parsed);
  return {
    repository: requireIdentifier(record.repository),
    decisionId: requireIdentifier(record.decisionId),
    expectedStateFingerprint: requireFingerprint(record.expectedStateFingerprint),
  };
}

function successProjection(result: LaterActionResult): Record<string, unknown> {
  return {
    status: result.status,
    repository: result.repository,
    projectId: result.projectId,
    decisionId: result.decisionId,
    stateFingerprint: result.stateFingerprint,
    observedAt: result.observedAt,
  };
}

function actionFailure(error: LaterActionError): Response {
  switch (error.code) {
    case "INVALID_REQUEST":
      return routeError(error.code, 400);
    case "ACTION_NOT_ALLOWED":
      return routeError(error.code, 403);
    case "DECISION_NOT_FOUND":
    case "AUTHORIZATION_STALE_STATE":
    case "PERSISTENCE_CONFLICT":
      return routeError(error.code, 409);
    case "RECONCILIATION_FAILED":
      return routeError(error.code, 502);
    case "PERSISTENCE_FAILED":
      return routeError(error.code, 500);
    default:
      return routeError("LATER_FAILED", 500);
  }
}

export async function handleGitHubLaterRequest(
  request: Request,
  runtime: LaterWorkerRuntime | null,
  dependencies: GitHubLaterHandlerDependencies = {},
): Promise<Response> {
  const routeFailure = assertRouteShape(request);
  if (routeFailure) return routeFailure;
  if (runtime === null) return routeError("RUNTIME_UNAVAILABLE", 503);

  let actor: LaterDecisionActor;
  try {
    actor = await runtime.authenticator.authenticateRequest(request);
  } catch {
    return routeError("ACCESS_AUTHENTICATION_FAILED", 403);
  }

  try {
    const payload = await parsePayload(request);
    const resolveProject = dependencies.resolveProject ?? resolveLaterProjectPolicy;
    const project = resolveProject(payload.repository);
    if (!project || project.canLater !== true) {
      return routeError("ACTION_NOT_ALLOWED", 403);
    }

    const result = await runtime.executeDecision({
      ...payload,
      repository: project.repository,
      actor: { subject: actor.subject, email: actor.email },
    });
    return jsonResponse(successProjection(result));
  } catch (error) {
    if (error instanceof LaterRouteInputError) return routeError("INVALID_REQUEST", 400);
    if (error instanceof RepositoryLaterNotAllowedError) {
      return routeError("ACTION_NOT_ALLOWED", 403);
    }
    if (error instanceof LaterActionError) return actionFailure(error);
    return routeError("LATER_FAILED", 500);
  }
}
