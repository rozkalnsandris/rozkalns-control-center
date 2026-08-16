import type {
  AccessJwksManualFetchProbeLike,
  AccessJwksManualFetchProbeResult,
} from "./access-jwks-manual-fetch-probe.js";
import { CloudflareAccessAuthenticationError } from "./access-request-authenticator.js";

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

async function runBoundedJwksFetchProbe(
  probe: AccessJwksManualFetchProbeLike,
): Promise<AccessJwksManualFetchProbeResult> {
  try {
    return await probe.probe();
  } catch {
    return "JWKS_MANUAL_FETCH_FAILED";
  }
}

export async function handleAccessAuthCanaryRequest(
  request: Request,
  authenticator: AccessRequestAuthenticatorLike | null,
  jwksFetchProbe: AccessJwksManualFetchProbeLike | null = null,
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
  } catch (error) {
    if (error instanceof CloudflareAccessAuthenticationError) {
      if (error.reason === "ACCESS_JWKS_FETCH_TYPE_ERROR" && jwksFetchProbe) {
        return jsonResponse(
          {
            error: "ACCESS_AUTHENTICATION_FAILED",
            diagnostic: error.reason,
            jwksFetchProbe: await runBoundedJwksFetchProbe(jwksFetchProbe),
          },
          403,
        );
      }

      return jsonResponse(
        {
          error: "ACCESS_AUTHENTICATION_FAILED",
          diagnostic: error.reason,
        },
        403,
      );
    }
    return routeError("ACCESS_AUTHENTICATION_FAILED", 403);
  }

  return jsonResponse({ status: "AUTHENTICATED" });
}
