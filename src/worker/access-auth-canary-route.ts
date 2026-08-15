export const ACCESS_AUTH_CANARY_ROUTE_PATH = "/api/auth/access-canary" as const;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export interface AccessRequestAuthenticatorLike {
  authenticateRequest(request: Request): Promise<unknown>;
}

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

export async function handleAccessAuthCanaryRequest(
  request: Request,
  authenticator: AccessRequestAuthenticatorLike | null,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== ACCESS_AUTH_CANARY_ROUTE_PATH) {
    return routeError("NOT_FOUND", 404);
  }
  if (request.method !== "GET") {
    return routeError("METHOD_NOT_ALLOWED", 405, { Allow: "GET" });
  }
  if (url.search !== "") {
    return routeError("INVALID_REQUEST", 400);
  }
  if (!authenticator) {
    return routeError("ACCESS_AUTH_CANARY_DISABLED", 503);
  }

  try {
    await authenticator.authenticateRequest(request);
  } catch {
    return routeError("ACCESS_AUTHENTICATION_FAILED", 403);
  }

  return jsonResponse({ status: "AUTHENTICATED" });
}
