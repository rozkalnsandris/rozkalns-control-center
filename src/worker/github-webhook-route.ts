import {
  authenticateGitHubWebhookRequest,
  InvalidWebhookError,
  type VerifiedGitHubWebhook,
} from "../shared/github-webhook.js";
import { resolveManagedProjectPolicy } from "../shared/project-policy.js";

export const GITHUB_WEBHOOK_ROUTE_PATH = "/api/github/webhook" as const;
export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 1024 * 1024;

export type DurableWebhookAcceptance = "ACCEPTED" | "DUPLICATE";

export interface VerifiedGitHubWebhookAcceptor {
  accept(webhook: VerifiedGitHubWebhook, receivedAt: string): Promise<DurableWebhookAcceptance>;
}

export interface GitHubWebhookRouteOptions {
  readonly secret: string | null;
  readonly acceptor: VerifiedGitHubWebhookAcceptor | null;
}

function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  return headers;
}

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: noStoreHeaders(extraHeaders),
  });
}

function routeError(code: string, status: number, extraHeaders?: HeadersInit): Response {
  return jsonResponse({ error: code }, status, extraHeaders);
}

function contentLength(request: Request): number | null | "INVALID" {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  if (!/^[0-9]+$/.test(raw)) return "INVALID";
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return "INVALID";
  return parsed;
}

function isJsonContentType(request: Request): boolean {
  const raw = request.headers.get("content-type");
  if (!raw) return false;
  return raw.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function receivedAtIsValid(receivedAt: string): boolean {
  return receivedAt.endsWith("Z") && !Number.isNaN(Date.parse(receivedAt));
}

function isFilteredNonTerminalCiWebhook(webhook: VerifiedGitHubWebhook): boolean {
  if (webhook.eventName === "check_run") {
    return webhook.action === "created";
  }
  if (webhook.eventName === "workflow_run") {
    return webhook.action === "requested" || webhook.action === "in_progress";
  }
  return false;
}

export async function handleGitHubWebhookRequest(
  request: Request,
  receivedAt: string,
  options: GitHubWebhookRouteOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== GITHUB_WEBHOOK_ROUTE_PATH) return routeError("NOT_FOUND", 404);
  if (request.method !== "POST") {
    return routeError("METHOD_NOT_ALLOWED", 405, { Allow: "POST" });
  }
  if (url.search !== "") return routeError("INVALID_REQUEST", 400);
  if (!receivedAtIsValid(receivedAt)) return routeError("WEBHOOK_UNAVAILABLE", 503);
  if (!options.secret) return routeError("WEBHOOK_UNAVAILABLE", 503);
  if (!isJsonContentType(request)) return routeError("UNSUPPORTED_MEDIA_TYPE", 415);

  const declaredLength = contentLength(request);
  if (declaredLength === "INVALID") return routeError("INVALID_REQUEST", 400);
  if (declaredLength !== null && declaredLength > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
    return routeError("PAYLOAD_TOO_LARGE", 413);
  }

  let rawBody: Uint8Array;
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
      return routeError("PAYLOAD_TOO_LARGE", 413);
    }
    rawBody = new Uint8Array(body);
  } catch {
    return routeError("INVALID_REQUEST", 400);
  }

  let authenticated;
  try {
    authenticated = await authenticateGitHubWebhookRequest(rawBody, request.headers, options.secret);
  } catch (error) {
    if (error instanceof InvalidWebhookError) return routeError("WEBHOOK_REJECTED", 403);
    return routeError("WEBHOOK_REJECTED", 403);
  }

  if (authenticated.kind === "PING") {
    return jsonResponse({ status: "PING" }, 200);
  }

  const webhook = authenticated.webhook;
  if (!resolveManagedProjectPolicy(webhook.repository)) {
    return routeError("WEBHOOK_REJECTED", 403);
  }

  if (isFilteredNonTerminalCiWebhook(webhook)) {
    return jsonResponse({ status: "FILTERED" }, 202);
  }

  if (!options.acceptor) return routeError("DURABILITY_NOT_READY", 503);

  let acceptance: DurableWebhookAcceptance;
  try {
    acceptance = await options.acceptor.accept(webhook, receivedAt);
  } catch {
    return routeError("DURABILITY_FAILED", 503);
  }

  if (acceptance !== "ACCEPTED" && acceptance !== "DUPLICATE") {
    return routeError("DURABILITY_FAILED", 503);
  }

  return jsonResponse({ status: acceptance }, 202);
}
