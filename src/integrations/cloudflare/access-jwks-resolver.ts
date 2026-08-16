import {
  CloudflareAccessSigningKeyResolutionError,
  type CloudflareAccessSigningKeyResolver,
} from "./access-jwt-verifier.js";

const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";
const MAX_JWKS_RESPONSE_BYTES = 32 * 1024;
const MAX_JWKS_KEYS = 4;
const MAX_KID_LENGTH = 200;
const MAX_RSA_MODULUS_LENGTH = 2048;
const MAX_RSA_EXPONENT_LENGTH = 32;
const MIN_CACHE_TTL_MS = 1_000;
const MAX_CACHE_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const KID_PATTERN = /^[A-Za-z0-9._:+/-]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type NormalizedAccessJwk = JsonWebKey & { readonly kid: string };

export type CloudflareAccessJwksErrorCode =
  | "ACCESS_JWKS_CONFIG_INVALID"
  | "ACCESS_JWKS_FETCH_FAILED"
  | "ACCESS_JWKS_RESPONSE_INVALID"
  | "ACCESS_JWKS_SET_INVALID"
  | "ACCESS_JWKS_KEY_NOT_FOUND";

export class CloudflareAccessJwksError extends CloudflareAccessSigningKeyResolutionError {
  readonly code: CloudflareAccessJwksErrorCode;

  constructor(code: CloudflareAccessJwksErrorCode) {
    super(code);
    this.name = "CloudflareAccessJwksError";
    this.code = code;
  }
}

export type CloudflareAccessJwksFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface CloudflareAccessJwksResolverConfig {
  readonly issuer: string;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
  readonly fetch?: CloudflareAccessJwksFetch;
  readonly now?: () => number;
}

function fail(code: CloudflareAccessJwksErrorCode): never {
  throw new CloudflareAccessJwksError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("ACCESS_JWKS_CONFIG_INVALID");
  return value;
}

function normalizeIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("ACCESS_JWKS_CONFIG_INVALID");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname.endsWith(".cloudflareaccess.com") ||
    url.hostname === ".cloudflareaccess.com"
  ) {
    fail("ACCESS_JWKS_CONFIG_INVALID");
  }

  return url.origin;
}

function normalizeKid(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_KID_LENGTH ||
    hasControlCharacters(value) ||
    !KID_PATTERN.test(value)
  ) {
    fail("ACCESS_JWKS_SET_INVALID");
  }
  return value;
}

function normalizeBase64Url(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    !BASE64URL_PATTERN.test(value)
  ) {
    fail("ACCESS_JWKS_SET_INVALID");
  }
  return value;
}

function normalizeSigningJwk(value: unknown): NormalizedAccessJwk {
  if (
    !isRecord(value) ||
    value.kty !== "RSA" ||
    value.alg !== "RS256" ||
    value.use !== "sig"
  ) {
    fail("ACCESS_JWKS_SET_INVALID");
  }

  const kid = normalizeKid(value.kid);
  const n = normalizeBase64Url(value.n, MAX_RSA_MODULUS_LENGTH);
  const e = normalizeBase64Url(value.e, MAX_RSA_EXPONENT_LENGTH);

  let keyOps: string[] | undefined;
  if (value.key_ops !== undefined) {
    if (
      !Array.isArray(value.key_ops) ||
      value.key_ops.length === 0 ||
      value.key_ops.some((operation) => operation !== "verify")
    ) {
      fail("ACCESS_JWKS_SET_INVALID");
    }
    keyOps = ["verify"];
  }

  return {
    kty: "RSA",
    kid,
    alg: "RS256",
    use: "sig",
    n,
    e,
    ...(keyOps ? { key_ops: keyOps } : {}),
  };
}

function cloneJwk(jwk: JsonWebKey): JsonWebKey {
  return {
    kty: jwk.kty,
    alg: jwk.alg,
    use: jwk.use,
    n: jwk.n,
    e: jwk.e,
    ...(jwk.key_ops ? { key_ops: [...jwk.key_ops] } : {}),
  };
}

function parseJwks(text: string): Map<string, JsonWebKey> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("ACCESS_JWKS_SET_INVALID");
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length === 0 || parsed.keys.length > MAX_JWKS_KEYS) {
    fail("ACCESS_JWKS_SET_INVALID");
  }

  const keys = new Map<string, JsonWebKey>();
  for (const candidate of parsed.keys) {
    const jwk = normalizeSigningJwk(candidate);
    if (keys.has(jwk.kid)) fail("ACCESS_JWKS_SET_INVALID");
    keys.set(jwk.kid, cloneJwk(jwk));
  }

  return keys;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) fail("ACCESS_JWKS_RESPONSE_INVALID");
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_JWKS_RESPONSE_BYTES) {
      fail("ACCESS_JWKS_RESPONSE_INVALID");
    }
  }

  if (!response.body) fail("ACCESS_JWKS_RESPONSE_INVALID");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("ACCESS_JWKS_RESPONSE_INVALID");
      totalLength += value.byteLength;
      if (totalLength > MAX_JWKS_RESPONSE_BYTES) fail("ACCESS_JWKS_RESPONSE_INVALID");
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CloudflareAccessJwksError) throw error;
    fail("ACCESS_JWKS_RESPONSE_INVALID");
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    fail("ACCESS_JWKS_RESPONSE_INVALID");
  }
}

export class CloudflareAccessJwksResolver implements CloudflareAccessSigningKeyResolver {
  readonly #endpoint: string;
  readonly #cacheTtlMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: CloudflareAccessJwksFetch;
  readonly #now: () => number;

  #cache: Map<string, JsonWebKey> | null = null;
  #expiresAtMs = 0;
  #refreshPromise: Promise<void> | null = null;

  constructor(config: CloudflareAccessJwksResolverConfig) {
    const issuer = normalizeIssuer(config.issuer);
    this.#endpoint = new URL(ACCESS_CERTS_PATH, `${issuer}/`).toString();
    this.#cacheTtlMs = boundedInteger(config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, MIN_CACHE_TTL_MS, MAX_CACHE_TTL_MS);
    this.#timeoutMs = boundedInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.#now = config.now ?? (() => Date.now());
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  async resolveSigningKey(kid: string): Promise<JsonWebKey> {
    const normalizedKid = normalizeKid(kid);
    const now = this.#readNow();
    const cacheFresh = this.#cache !== null && now < this.#expiresAtMs;

    if (cacheFresh) {
      const cached = this.#cache?.get(normalizedKid);
      if (cached) return cloneJwk(cached);
      await this.#refresh();
    } else {
      await this.#refresh();
    }

    const refreshed = this.#cache?.get(normalizedKid);
    if (!refreshed) fail("ACCESS_JWKS_KEY_NOT_FOUND");
    return cloneJwk(refreshed);
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isFinite(now) || now < 0) fail("ACCESS_JWKS_CONFIG_INVALID");
    return Math.floor(now);
  }

  async #refresh(): Promise<void> {
    if (this.#refreshPromise) return this.#refreshPromise;

    const refresh = this.#performRefresh().finally(() => {
      if (this.#refreshPromise === refresh) this.#refreshPromise = null;
    });
    this.#refreshPromise = refresh;
    return refresh;
  }

  async #performRefresh(): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      fail("ACCESS_JWKS_FETCH_FAILED");
    }

    if (!response.ok) fail("ACCESS_JWKS_RESPONSE_INVALID");

    const body = await readBoundedResponseText(response);
    const nextCache = parseJwks(body);
    const refreshedAt = this.#readNow();

    this.#cache = nextCache;
    this.#expiresAtMs = refreshedAt + this.#cacheTtlMs;
  }
}
