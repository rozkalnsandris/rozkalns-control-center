import type { OwnerWorkflowAction, OwnerWorkflowTarget } from "../shared/project-policy.js";
import { resolveManagedProjectPolicy, resolveOwnerWorkflowTarget } from "../shared/project-policy.js";
import { CloudflareAccessAuthenticationError } from "./access-request-authenticator.js";

export const GITHUB_OWNER_ACTION_ROUTE_PATH = "/api/github/owner-action" as const;
const BODY_MAX_BYTES = 2048;
const REQUEST_KEYS = ["action", "expectedMainSha", "repository", "requestId"] as const;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface OwnerActionRequestAuthenticator { authenticateRequest(request: Request): Promise<unknown>; }
export interface OwnerActionDispatchInput { readonly action: OwnerWorkflowAction; readonly repository: string; readonly target: OwnerWorkflowTarget; readonly expectedMainSha: string; readonly requestId: string; }
export interface OwnerActionDispatchResult { readonly status: "DISPATCHED"; readonly action: OwnerWorkflowAction; readonly repository: string; readonly workflow: string; readonly ref: string; readonly expectedMainSha: string; readonly observedMainSha: string; readonly requestId: string; }
export interface OwnerActionWorkerRuntime { readonly authenticator: OwnerActionRequestAuthenticator; dispatch(input: OwnerActionDispatchInput): Promise<OwnerActionDispatchResult>; }
export class OwnerActionRuntimeError extends Error { constructor(readonly code: "ACTIONS_PERMISSION_REQUIRED" | "STALE_MAIN_SHA" | "DISPATCH_REJECTED" | "DISPATCH_OUTCOME_UNKNOWN") { super(code); this.name = "OwnerActionRuntimeError"; } }

class InputError extends Error {}
function headers(extra?: HeadersInit) { const value = new Headers(extra); value.set("Cache-Control", "no-store"); return value; }
function json(body: unknown, status = 200, extra?: HeadersInit) { return Response.json(body, { status, headers: headers(extra) }); }
function error(code: string, status: number, retryable?: false) { return json(retryable === false ? { error: code, retryable: false } : { error: code }, status); }
function string(value: unknown) { if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) throw new InputError(); return value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(); const result = value as Record<string, unknown>; if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(REQUEST_KEYS)) throw new InputError(); return result; }
async function payload(request: Request) {
  const text = await request.text().catch(() => { throw new InputError(); }); if (new TextEncoder().encode(text).byteLength > BODY_MAX_BYTES) throw new InputError();
  const parsed = JSON.parse(text) as unknown; const value = record(parsed); const action = string(value.action); if (action !== "LIVE" && action !== "CONTINUE") throw new InputError(); const expectedMainSha = string(value.expectedMainSha); if (!SHA_PATTERN.test(expectedMainSha)) throw new InputError(); const requestId = string(value.requestId); if (!REQUEST_ID_PATTERN.test(requestId)) throw new InputError();
  return { action, repository: string(value.repository), expectedMainSha, requestId } as const;
}

export async function handleGitHubOwnerActionRequest(request: Request, runtime: OwnerActionWorkerRuntime | null): Promise<Response> {
  const url = new URL(request.url); if (url.pathname !== GITHUB_OWNER_ACTION_ROUTE_PATH) return error("NOT_FOUND", 404); if (url.search !== "") return error("INVALID_REQUEST", 400);
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET, POST" });
  if (runtime === null) return error("RUNTIME_UNAVAILABLE", 503);
  if (request.method === "GET") { try { await runtime.authenticator.authenticateRequest(request); return json({ status: "AUTHENTICATED" }); } catch (cause) { if (cause instanceof CloudflareAccessAuthenticationError) return error("ACCESS_AUTHENTICATION_FAILED", 403); return error("ACCESS_AUTHENTICATION_FAILED", 403); } }
  const media = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""; if (media !== "application/json") return error("UNSUPPORTED_MEDIA_TYPE", 415);
  try {
    await runtime.authenticator.authenticateRequest(request);
    const input = await payload(request); const policy = resolveManagedProjectPolicy(input.repository); if (!policy) return error("ACTION_NOT_ALLOWED", 403); const target = resolveOwnerWorkflowTarget(policy.repository, input.action); if (!target) return error("ACTION_NOT_ALLOWED", 403);
    const result = await runtime.dispatch({ ...input, repository: policy.repository, target }); return json(result);
  } catch (cause) {
    if (cause instanceof InputError || cause instanceof SyntaxError) return error("INVALID_REQUEST", 400);
    if (cause instanceof CloudflareAccessAuthenticationError) return error("ACCESS_AUTHENTICATION_FAILED", 403);
    if (cause instanceof OwnerActionRuntimeError) { if (cause.code === "ACTIONS_PERMISSION_REQUIRED") return error(cause.code, 503); if (cause.code === "STALE_MAIN_SHA") return error(cause.code, 409); if (cause.code === "DISPATCH_OUTCOME_UNKNOWN") return error(cause.code, 502, false); return error(cause.code, 502); }
    return error("OWNER_ACTION_FAILED", 500);
  }
}
