import { ContinuationActionError, type ContinuationActionRequest } from "../shared/continuation-action.js";
import type { ContinuationActionRuntime } from "./continuation-action-runtime.js";

export const CONTINUATION_ACTION_PATH = "/api/control/continuation";
export const CONTINUATION_PREFLIGHT_PATH = `${CONTINUATION_ACTION_PATH}/preflight`;
const sha = /^[0-9a-f]{40}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleContinuationActionRequest(request: Request, runtime: ContinuationActionRuntime | null): Promise<Response> {
  const url = new URL(request.url);
  const preflight = url.pathname === CONTINUATION_PREFLIGHT_PATH;
  if (!preflight && url.pathname !== CONTINUATION_ACTION_PATH) return json({ error: "NOT_FOUND" }, 404);
  if (request.method !== (preflight ? "GET" : "POST")) return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!runtime) return json({ error: "CONTINUATION_DISABLED_OR_RUNTIME_UNAVAILABLE" }, 503);
  let actor;
  try { actor = await runtime.authenticator.authenticateRequest(request); }
  catch { return json({ error: "ACCESS_AUTHENTICATION_FAILED" }, 403); }
  try {
    if (preflight) {
      if ([...url.searchParams.keys()].sort().join(",") !== "decisionId,expectedMainSha,repository") return json({ error: "INVALID_REQUEST" }, 400);
      const repository = url.searchParams.get("repository") ?? "";
      const decisionId = url.searchParams.get("decisionId") ?? "";
      const main = url.searchParams.get("expectedMainSha") ?? "";
      if (repository.length > 255 || decisionId.length > 256 || !sha.test(main)) return json({ error: "INVALID_REQUEST" }, 400);
      return json(await runtime.preflight(repository, decisionId, main));
    }
    if (url.search || request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return json({ error: "INVALID_REQUEST" }, 400);
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 2048) return json({ error: "INVALID_REQUEST" }, 400);
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "INVALID_REQUEST" }, 400);
    const payload = value as Record<string, unknown>;
    if (Object.keys(payload).sort().join(",") !== "action,campaignId,expectedMainSha,repository,requestId,revision" ||
      (payload.action !== "CONTINUE" && payload.action !== "PAUSE") || typeof payload.repository !== "string" || payload.repository.length > 255 ||
      typeof payload.campaignId !== "string" || !identifier.test(payload.campaignId) || typeof payload.expectedMainSha !== "string" || !sha.test(payload.expectedMainSha) ||
      typeof payload.revision !== "string" || !/^[0-9a-f]{64}$/.test(payload.revision) || typeof payload.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(payload.requestId)) return json({ error: "INVALID_REQUEST" }, 400);
    return json(await runtime.execute(payload as unknown as ContinuationActionRequest, { subject: actor.subject, email: actor.email }));
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "INVALID_REQUEST" }, 400);
    return json({ error: error instanceof ContinuationActionError ? error.code : "CONTINUATION_FAILED_CLOSED" }, 409);
  }
}
