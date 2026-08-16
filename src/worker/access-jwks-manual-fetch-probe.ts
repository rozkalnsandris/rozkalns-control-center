import {
  CloudflareAccessJwksResolver,
  type CloudflareAccessJwksFetch,
} from "../integrations/cloudflare/access-jwks-resolver.js";

const MANUAL_PROBE_TIMEOUT_MS = 3_000;

type KnownFetchFailureName = "TimeoutError" | "AbortError" | "TypeError";

export type AccessJwksManualFetchProbeResult =
  | "JWKS_MANUAL_HTTP_200"
  | "JWKS_MANUAL_HTTP_3XX"
  | "JWKS_MANUAL_HTTP_OTHER"
  | "JWKS_MANUAL_FETCH_TIMEOUT"
  | "JWKS_MANUAL_FETCH_TYPE_ERROR"
  | "JWKS_MANUAL_FETCH_FAILED";

export interface AccessJwksManualFetchProbeLike {
  probe(): Promise<AccessJwksManualFetchProbeResult>;
}

export interface AccessJwksManualFetchProbeConfig {
  readonly issuer: string;
  readonly fetch?: CloudflareAccessJwksFetch;
}

function readKnownFailureName(error: unknown): KnownFetchFailureName | null {
  if (typeof error !== "object" || error === null) return null;

  try {
    const name = Reflect.get(error, "name");
    if (name === "TimeoutError" || name === "AbortError" || name === "TypeError") {
      return name;
    }
  } catch {
    return null;
  }

  return null;
}

function isNativeTypeError(error: unknown): boolean {
  try {
    return error instanceof TypeError;
  } catch {
    return false;
  }
}

function classifyFailure(error: unknown): AccessJwksManualFetchProbeResult {
  const name = readKnownFailureName(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return "JWKS_MANUAL_FETCH_TIMEOUT";
  }
  if (isNativeTypeError(error) || name === "TypeError") {
    return "JWKS_MANUAL_FETCH_TYPE_ERROR";
  }
  return "JWKS_MANUAL_FETCH_FAILED";
}

function classifyResponse(response: Response): AccessJwksManualFetchProbeResult {
  let status: unknown;
  try {
    status = Reflect.get(response, "status");
  } catch {
    return "JWKS_MANUAL_FETCH_FAILED";
  }

  if (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599) {
    return "JWKS_MANUAL_FETCH_FAILED";
  }
  if (status === 200) return "JWKS_MANUAL_HTTP_200";
  if ((status as number) >= 300 && (status as number) <= 399) return "JWKS_MANUAL_HTTP_3XX";
  return "JWKS_MANUAL_HTTP_OTHER";
}

export class AccessJwksManualFetchProbe implements AccessJwksManualFetchProbeLike {
  readonly #endpoint: string;
  readonly #fetch: CloudflareAccessJwksFetch;

  constructor(config: AccessJwksManualFetchProbeConfig) {
    this.#endpoint = new CloudflareAccessJwksResolver({ issuer: config.issuer }).endpoint;
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  async probe(): Promise<AccessJwksManualFetchProbeResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(MANUAL_PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      return classifyFailure(error);
    }

    return classifyResponse(response);
  }
}
