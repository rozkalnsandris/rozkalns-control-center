import type {
  WebhookDeliveryObservabilityReader,
  WebhookDeliveryObservabilitySnapshot,
} from "../integrations/cloudflare/d1-delivery-observability-reader.js";

export const GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH = "/api/github/webhook-deliveries" as const;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (extraHeaders) {
    const extra = new Headers(extraHeaders);
    extra.forEach((value, key) => headers.set(key, value));
  }
  return Response.json(body, { status, headers });
}

function routeError(code: string, status: number, extraHeaders?: HeadersInit): Response {
  return jsonResponse({ error: code }, status, extraHeaders);
}

export async function handleGitHubWebhookObservabilityRequest(
  request: Request,
  observedAt: string,
  reader: WebhookDeliveryObservabilityReader | null,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH) {
    return routeError("NOT_FOUND", 404);
  }
  if (request.method !== "GET") {
    return routeError("METHOD_NOT_ALLOWED", 405, { Allow: "GET" });
  }
  if (url.search !== "") {
    return routeError("INVALID_REQUEST", 400);
  }
  if (!reader) {
    return routeError("WEBHOOK_OBSERVABILITY_DISABLED", 503);
  }

  let snapshot: WebhookDeliveryObservabilitySnapshot;
  try {
    snapshot = await reader.readSnapshot(observedAt);
  } catch {
    return routeError("WEBHOOK_OBSERVABILITY_FAILED", 503);
  }

  return jsonResponse(snapshot);
}
