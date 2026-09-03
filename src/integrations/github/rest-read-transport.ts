import {
  GITHUB_REST_API_VERSION,
  assertGitHubCredentialLeaseUsable,
  createGitHubReadRequest,
  parseGitHubInstallationReadScope,
  type GitHubCredentialLeaseEvidence,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
  type GitHubRateLimitEvidence,
  type GitHubReadOptions,
  type GitHubReadPageOutcome,
  type GitHubReadRequest,
  type GitHubReadResult,
} from "./app-installation-read-contract.js";

export const GITHUB_REST_ORIGIN = "https://api.github.com" as const;
export const GITHUB_REST_ACCEPT = "application/vnd.github+json" as const;
export const GITHUB_REST_DEFAULT_MAX_REQUESTS = 10;
export const GITHUB_REST_MAX_REQUEST_BUDGET = 100;
export const GITHUB_REST_CONDITIONAL_CACHE_MAX_ENTRIES = 100;
export const GITHUB_REST_CONDITIONAL_CACHE_MAX_BODY_BYTES = 1024 * 1024;
export const GITHUB_REST_CONDITIONAL_CACHE_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

export type GitHubRestReadFailureCode =
  | "INVALID_REQUEST"
  | "CREDENTIAL_UNAVAILABLE"
  | "CREDENTIAL_UNUSABLE"
  | "TRANSPORT_FAILURE"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "MALFORMED_RESPONSE"
  | "PAGINATION_BOUNDARY_VIOLATION"
  | "PAGINATION_CYCLE"
  | "PAGINATION_BUDGET_EXHAUSTED"
  | "UNEXPECTED_STATUS";

const failureMessages: Readonly<Record<GitHubRestReadFailureCode, string>> = {
  INVALID_REQUEST: "GitHub REST read request failed validation",
  CREDENTIAL_UNAVAILABLE: "GitHub REST read credential session is unavailable",
  CREDENTIAL_UNUSABLE: "GitHub REST read credential lease is unusable",
  TRANSPORT_FAILURE: "GitHub REST read transport failed",
  RATE_LIMITED: "GitHub REST read is rate limited",
  UNAUTHORIZED: "GitHub REST read is unauthorized",
  FORBIDDEN: "GitHub REST read is forbidden",
  NOT_FOUND: "GitHub REST read resource was not found",
  MALFORMED_RESPONSE: "GitHub REST read response is malformed",
  PAGINATION_BOUNDARY_VIOLATION: "GitHub REST pagination left the approved repository boundary",
  PAGINATION_CYCLE: "GitHub REST pagination cycle detected",
  PAGINATION_BUDGET_EXHAUSTED: "GitHub REST pagination request budget exhausted",
  UNEXPECTED_STATUS: "GitHub REST read returned an unexpected HTTP status",
};

export class GitHubRestReadError extends Error {
  readonly code: GitHubRestReadFailureCode;
  readonly status: number | null;
  readonly retryNotBefore: string | null;
  readonly rateLimit: GitHubRateLimitEvidence | null;

  constructor(
    code: GitHubRestReadFailureCode,
    options: {
      status?: number | null;
      retryNotBefore?: string | null;
      rateLimit?: GitHubRateLimitEvidence | null;
    } = {},
  ) {
    super(failureMessages[code]);
    this.name = "GitHubRestReadError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryNotBefore = options.retryNotBefore ?? null;
    this.rateLimit = options.rateLimit ?? null;
  }
}

export interface GitHubAuthorizedRestGet {
  readonly method: "GET";
  readonly url: string;
  readonly accept: typeof GITHUB_REST_ACCEPT;
  readonly apiVersion: typeof GITHUB_REST_API_VERSION;
  readonly redirect: "manual";
  readonly ifNoneMatch?: string;
}

export interface GitHubInstallationAuthorizedReadSession {
  readonly credentialLease: GitHubCredentialLeaseEvidence;
  execute(request: GitHubAuthorizedRestGet): Promise<Response>;
}

export type GitHubInstallationAuthorizedReadSessionProvider = (
  scope: GitHubInstallationReadScope,
  observedAt: string,
) => Promise<GitHubInstallationAuthorizedReadSession>;

export interface GitHubRestReadTransportOptions {
  readonly maxRequests?: number;
  readonly conditionalCache?: GitHubRestConditionalCache;
}

interface GitHubRestConditionalCacheEntry {
  readonly validator: string;
  readonly body: unknown;
  readonly nextUrl: string | null;
  readonly bodyBytes: number;
}

export interface GitHubRestConditionalCache {
  get(key: string): GitHubRestConditionalCacheEntry | null;
  set(key: string, entry: GitHubRestConditionalCacheEntry): void;
  delete(key: string): void;
}

export function createGitHubRestConditionalCache(): GitHubRestConditionalCache {
  const entries = new Map<string, GitHubRestConditionalCacheEntry>();
  let totalBytes = 0;

  function remove(key: string): void {
    const existing = entries.get(key);
    if (existing) totalBytes -= existing.bodyBytes;
    entries.delete(key);
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(key, entry) {
      if (
        entry.bodyBytes < 0 ||
        entry.bodyBytes > GITHUB_REST_CONDITIONAL_CACHE_MAX_BODY_BYTES
      ) return;
      remove(key);
      entries.set(key, entry);
      totalBytes += entry.bodyBytes;
      while (
        entries.size > GITHUB_REST_CONDITIONAL_CACHE_MAX_ENTRIES ||
        totalBytes > GITHUB_REST_CONDITIONAL_CACHE_MAX_TOTAL_BYTES
      ) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        remove(oldest);
      }
    },
    delete: remove,
  };
}

export function normalizeGitHubEtag(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 256 ||
    !/^(?:W\/)?"[!#-~]+"$/.test(value)
  ) {
    throw new GitHubRestReadError("INVALID_REQUEST");
  }
  return value;
}

function parseObservedAt(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new GitHubRestReadError("INVALID_REQUEST");
  return parsed;
}

function normalizeRequest(
  scope: GitHubInstallationReadScope,
  request: GitHubReadRequest,
): GitHubReadRequest {
  try {
    if (request.apiVersion !== GITHUB_REST_API_VERSION) throw new Error("unsupported API version");
    return createGitHubReadRequest(scope, request.repository, request.path, request.requiredPermission);
  } catch {
    throw new GitHubRestReadError("INVALID_REQUEST");
  }
}

function normalizeMaxRequests(value: number | undefined): number {
  if (value === undefined) return GITHUB_REST_DEFAULT_MAX_REQUESTS;
  if (!Number.isSafeInteger(value) || value < 1 || value > GITHUB_REST_MAX_REQUEST_BUDGET) {
    throw new GitHubRestReadError("INVALID_REQUEST");
  }
  return value;
}

function decodedPathHasTraversal(pathname: string): boolean {
  for (const rawSegment of pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return true;
    }
    if (decoded.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return true;
  }
  return false;
}

function assertRepositoryUrl(url: URL, repository: string): void {
  if (url.origin !== GITHUB_REST_ORIGIN || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new GitHubRestReadError("PAGINATION_BOUNDARY_VIOLATION");
  }

  if (decodedPathHasTraversal(url.pathname)) {
    throw new GitHubRestReadError("PAGINATION_BOUNDARY_VIOLATION");
  }

  const repositoryPrefix = `/repos/${repository}`.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  if (pathname !== repositoryPrefix && !pathname.startsWith(`${repositoryPrefix}/`)) {
    throw new GitHubRestReadError("PAGINATION_BOUNDARY_VIOLATION");
  }
}

function initialUrl(request: GitHubReadRequest): URL {
  let url: URL;
  try {
    url = new URL(request.path, `${GITHUB_REST_ORIGIN}/`);
  } catch {
    throw new GitHubRestReadError("INVALID_REQUEST");
  }
  assertRepositoryUrl(url, request.repository);
  return url;
}

function splitLinkHeader(value: string): string[] {
  if (/\r|\n/.test(value)) throw new GitHubRestReadError("MALFORMED_RESPONSE");

  const segments: string[] = [];
  let start = 0;
  let inAngles = false;
  let inQuotes = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "<" && !inQuotes) inAngles = true;
    else if (character === ">" && !inQuotes) inAngles = false;
    else if (character === '"' && !inAngles) inQuotes = !inQuotes;
    else if (character === "," && !inAngles && !inQuotes) {
      const segment = value.slice(start, index).trim();
      if (segment === "") throw new GitHubRestReadError("MALFORMED_RESPONSE");
      segments.push(segment);
      start = index + 1;
    }
  }

  if (inAngles || inQuotes) throw new GitHubRestReadError("MALFORMED_RESPONSE");
  const finalSegment = value.slice(start).trim();
  if (finalSegment === "") throw new GitHubRestReadError("MALFORMED_RESPONSE");
  segments.push(finalSegment);
  return segments;
}

function nextLink(headers: Headers, repository: string): URL | null {
  const value = headers.get("link");
  if (value === null) return null;

  let next: URL | null = null;
  for (const segment of splitLinkHeader(value)) {
    const targetMatch = /^<([^>]+)>(.*)$/.exec(segment);
    if (!targetMatch) throw new GitHubRestReadError("MALFORMED_RESPONSE");

    const target = targetMatch[1];
    const parameters = targetMatch[2];
    const relMatch = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(parameters);
    if (!relMatch) continue;

    const rels = (relMatch[1] ?? relMatch[2] ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((rel) => rel.toLowerCase());
    if (!rels.includes("next")) continue;
    if (next !== null) throw new GitHubRestReadError("MALFORMED_RESPONSE");

    try {
      next = new URL(target);
    } catch {
      throw new GitHubRestReadError("MALFORMED_RESPONSE");
    }
    assertRepositoryUrl(next, repository);
  }

  return next;
}

function optionalHeaderInteger(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) throw new GitHubRestReadError("MALFORMED_RESPONSE");
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) throw new GitHubRestReadError("MALFORMED_RESPONSE");
  return parsed;
}

function epochSecondsToIso(value: number): string {
  const milliseconds = value * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(date.getTime())) {
    throw new GitHubRestReadError("MALFORMED_RESPONSE");
  }
  return date.toISOString();
}

export function parseGitHubRateLimitEvidence(headers: Headers): GitHubRateLimitEvidence | null {
  const limit = optionalHeaderInteger(headers, "x-ratelimit-limit");
  const remaining = optionalHeaderInteger(headers, "x-ratelimit-remaining");
  const used = optionalHeaderInteger(headers, "x-ratelimit-used");
  const reset = optionalHeaderInteger(headers, "x-ratelimit-reset");
  const rawResource = headers.get("x-ratelimit-resource");

  let resource: string | null = null;
  if (rawResource !== null) {
    const trimmed = rawResource.trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(trimmed)) throw new GitHubRestReadError("MALFORMED_RESPONSE");
    resource = trimmed;
  }

  if (limit === null && remaining === null && used === null && reset === null && resource === null) return null;
  if (limit !== null && remaining !== null && remaining > limit) throw new GitHubRestReadError("MALFORMED_RESPONSE");
  if (limit !== null && used !== null && used > limit) throw new GitHubRestReadError("MALFORMED_RESPONSE");

  return {
    limit,
    remaining,
    used,
    resetAt: reset === null ? null : epochSecondsToIso(reset),
    resource,
  };
}

function responseEtag(headers: Headers): string | null {
  const raw = headers.get("etag");
  if (raw === null) return null;
  try {
    return normalizeGitHubEtag(raw);
  } catch {
    throw new GitHubRestReadError("MALFORMED_RESPONSE");
  }
}

function conditionalCacheKey(
  scope: GitHubInstallationReadScope,
  request: GitHubReadRequest,
  url: URL,
): string {
  const repositories = [...scope.repositories].map((repository) => repository.toLowerCase()).sort();
  const permissions = Object.entries(scope.permissions).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    scope.installationId,
    repositories,
    permissions,
    request.repository.toLowerCase(),
    request.requiredPermission,
    url.href,
  ]);
}

function cacheableBody(body: unknown): { readonly body: unknown; readonly bodyBytes: number } | null {
  try {
    const serialized = JSON.stringify(body);
    const bodyBytes = new TextEncoder().encode(serialized).byteLength;
    if (bodyBytes > GITHUB_REST_CONDITIONAL_CACHE_MAX_BODY_BYTES) return null;
    return { body: JSON.parse(serialized) as unknown, bodyBytes };
  } catch {
    return null;
  }
}

function retryAfter(headers: Headers, observedAtMs: number): string | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) throw new GitHubRestReadError("MALFORMED_RESPONSE");
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds)) throw new GitHubRestReadError("MALFORMED_RESPONSE");
  const date = new Date(observedAtMs + seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new GitHubRestReadError("MALFORMED_RESPONSE");
  return date.toISOString();
}

function rateLimitError(
  response: Response,
  observedAtMs: number,
  rateLimit: GitHubRateLimitEvidence | null,
): GitHubRestReadError | null {
  if (response.status !== 403 && response.status !== 429) return null;

  const retryAfterValue = retryAfter(response.headers, observedAtMs);
  if (retryAfterValue !== null) {
    return new GitHubRestReadError("RATE_LIMITED", {
      status: response.status,
      retryNotBefore: retryAfterValue,
      rateLimit,
    });
  }

  if (rateLimit?.remaining === 0) {
    if (rateLimit.resetAt === null) throw new GitHubRestReadError("MALFORMED_RESPONSE", { status: response.status });
    return new GitHubRestReadError("RATE_LIMITED", {
      status: response.status,
      retryNotBefore: rateLimit.resetAt,
      rateLimit,
    });
  }

  if (response.status === 429) {
    return new GitHubRestReadError("RATE_LIMITED", {
      status: response.status,
      retryNotBefore: new Date(observedAtMs + 60_000).toISOString(),
      rateLimit,
    });
  }

  return null;
}

function assertSuccessfulStatus(
  response: Response,
  observedAtMs: number,
  rateLimit: GitHubRateLimitEvidence | null,
): void {
  const limited = rateLimitError(response, observedAtMs, rateLimit);
  if (limited) throw limited;
  if (response.status === 200) return;
  if (response.status === 401) throw new GitHubRestReadError("UNAUTHORIZED", { status: response.status, rateLimit });
  if (response.status === 403) throw new GitHubRestReadError("FORBIDDEN", { status: response.status, rateLimit });
  if (response.status === 404) throw new GitHubRestReadError("NOT_FOUND", { status: response.status, rateLimit });
  throw new GitHubRestReadError("UNEXPECTED_STATUS", { status: response.status, rateLimit });
}

async function parseJsonPage<T>(response: Response): Promise<T> {
  const rawContentType = response.headers.get("content-type");
  if (rawContentType === null) throw new GitHubRestReadError("MALFORMED_RESPONSE", { status: response.status });
  const mediaType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new GitHubRestReadError("MALFORMED_RESPONSE", { status: response.status });
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new GitHubRestReadError("MALFORMED_RESPONSE", { status: response.status });
  }
}

export function createGitHubRestReadTransport(
  acquireSession: GitHubInstallationAuthorizedReadSessionProvider,
  options: GitHubRestReadTransportOptions = {},
): GitHubInstallationReadTransport {
  const maxRequests = normalizeMaxRequests(options.maxRequests);
  const conditionalCache = options.conditionalCache;

  return {
    async get<T>(
      scopeInput: GitHubInstallationReadScope,
      requestInput: GitHubReadRequest,
      observedAt: string,
      readOptions: GitHubReadOptions = {},
    ): Promise<GitHubReadResult<T>> {
      const observedAtMs = parseObservedAt(observedAt);

      let scope: GitHubInstallationReadScope;
      try {
        scope = parseGitHubInstallationReadScope(scopeInput);
      } catch {
        throw new GitHubRestReadError("INVALID_REQUEST");
      }
      const request = normalizeRequest(scope, requestInput);
      if (
        Object.keys(readOptions).some((key) => key !== "cacheMode") ||
        (readOptions.cacheMode !== undefined && readOptions.cacheMode !== "READ_ONLY_CONDITIONAL") ||
        (readOptions.cacheMode === "READ_ONLY_CONDITIONAL" && conditionalCache === undefined)
      ) {
        throw new GitHubRestReadError("INVALID_REQUEST");
      }
      const useConditionalCache = readOptions.cacheMode === "READ_ONLY_CONDITIONAL";
      let currentUrl = initialUrl(request);

      let session: GitHubInstallationAuthorizedReadSession;
      try {
        session = await acquireSession(scope, observedAt);
      } catch {
        throw new GitHubRestReadError("CREDENTIAL_UNAVAILABLE");
      }

      try {
        assertGitHubCredentialLeaseUsable(session.credentialLease, scope, observedAt);
      } catch {
        throw new GitHubRestReadError("CREDENTIAL_UNUSABLE");
      }

      const pages: T[] = [];
      const visited = new Set<string>();
      let requestCount = 0;
      let lastRateLimit: GitHubRateLimitEvidence | null = null;
      const pageOutcomes: GitHubReadPageOutcome[] = [];

      while (true) {
        if (visited.has(currentUrl.href)) throw new GitHubRestReadError("PAGINATION_CYCLE");
        if (requestCount >= maxRequests) throw new GitHubRestReadError("PAGINATION_BUDGET_EXHAUSTED");
        visited.add(currentUrl.href);

        const cacheKey = conditionalCacheKey(scope, request, currentUrl);
        const cached = useConditionalCache ? conditionalCache?.get(cacheKey) ?? null : null;
        let cachedValidator: string | null = null;
        if (cached !== null) {
          try {
            cachedValidator = normalizeGitHubEtag(cached.validator);
          } catch {
            throw new GitHubRestReadError("MALFORMED_RESPONSE");
          }
        }
        let response: Response;
        try {
          response = await session.execute({
            method: "GET",
            url: currentUrl.href,
            accept: GITHUB_REST_ACCEPT,
            apiVersion: GITHUB_REST_API_VERSION,
            redirect: "manual",
            ...(cachedValidator === null ? {} : { ifNoneMatch: cachedValidator }),
          });
        } catch {
          throw new GitHubRestReadError("TRANSPORT_FAILURE");
        }
        requestCount += 1;

        const rateLimit = parseGitHubRateLimitEvidence(response.headers);
        if (rateLimit !== null) lastRateLimit = rateLimit;
        let next: URL | null;
        if (response.status === 304) {
          if (!useConditionalCache || cached === null) {
            throw new GitHubRestReadError("MALFORMED_RESPONSE", { status: response.status });
          }
          const validator = responseEtag(response.headers) ?? cachedValidator;
          if (validator === null || validator !== cachedValidator) {
            throw new GitHubRestReadError("MALFORMED_RESPONSE", { status: response.status });
          }
          pages.push(structuredClone(cached.body) as T);
          pageOutcomes.push({ kind: "NOT_MODIFIED", validator });
          if (cached.nextUrl === null) {
            next = null;
          } else {
            try {
              next = new URL(cached.nextUrl);
            } catch {
              throw new GitHubRestReadError("MALFORMED_RESPONSE", { status: response.status });
            }
            assertRepositoryUrl(next, request.repository);
          }
        } else {
          assertSuccessfulStatus(response, observedAtMs, rateLimit);
          const page = await parseJsonPage<T>(response);
          pages.push(page);
          next = nextLink(response.headers, request.repository);
          const validator = responseEtag(response.headers);
          pageOutcomes.push({ kind: "OK", validator });
          if (useConditionalCache) {
            if (validator === null) {
              conditionalCache?.delete(cacheKey);
            } else {
              const cachedBody = cacheableBody(page);
              if (cachedBody === null) {
                conditionalCache?.delete(cacheKey);
              } else {
                conditionalCache?.set(cacheKey, {
                  validator,
                  body: cachedBody.body,
                  nextUrl: next?.href ?? null,
                  bodyBytes: cachedBody.bodyBytes,
                });
              }
            }
          }
        }

        if (next === null) break;
        if (visited.has(next.href)) throw new GitHubRestReadError("PAGINATION_CYCLE");
        if (requestCount >= maxRequests) throw new GitHubRestReadError("PAGINATION_BUDGET_EXHAUSTED");
        currentUrl = next;
      }

      return {
        pages,
        credentialLease: session.credentialLease,
        requestCount,
        rateLimit: lastRateLimit,
        pageOutcomes,
      };
    },
  };
}
