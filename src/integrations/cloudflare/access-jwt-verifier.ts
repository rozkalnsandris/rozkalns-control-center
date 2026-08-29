const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const MAX_TOKEN_LENGTH = 8192;
const MAX_SEGMENT_BYTES = 4096;
const MAX_KID_LENGTH = 200;
const MAX_PRINCIPAL_LENGTH = 320;
const MAX_AUDIENCE_LENGTH = 200;
const MAX_AUDIENCE_DIAGNOSTIC_COUNT = 32;
const MAX_AUDIENCE_DIAGNOSTIC_FINGERPRINTS = 4;
const SERVICE_TOKEN_PRINCIPAL_PREFIX = "service-token:";
const MAX_SERVICE_TOKEN_COMMON_NAME_LENGTH = MAX_PRINCIPAL_LENGTH - SERVICE_TOKEN_PRINCIPAL_PREFIX.length;
const KID_PATTERN = /^[A-Za-z0-9._:+/-]+$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9._:+/-]+$/;

export type CloudflareAccessJwtErrorCode =
  | "ACCESS_JWT_MISSING"
  | "ACCESS_JWT_MALFORMED"
  | "ACCESS_JWT_HEADER_INVALID"
  | "ACCESS_JWT_KEY_UNAVAILABLE"
  | "ACCESS_JWT_KEY_INVALID"
  | "ACCESS_JWT_SIGNATURE_INVALID"
  | "ACCESS_JWT_CLAIMS_INVALID"
  | "ACCESS_JWT_ISSUER_INVALID"
  | "ACCESS_JWT_AUDIENCE_INVALID"
  | "ACCESS_JWT_EXPIRED"
  | "ACCESS_JWT_NOT_YET_VALID"
  | "ACCESS_JWT_ISSUED_IN_FUTURE";

export type CloudflareAccessAudienceShape = "ARRAY" | "STRING" | "OTHER";

export interface CloudflareAccessAudienceDiagnostic {
  readonly shape: CloudflareAccessAudienceShape;
  readonly count: number;
  readonly sha256: readonly string[];
}

export class CloudflareAccessJwtError extends Error {
  readonly code: CloudflareAccessJwtErrorCode;
  readonly audienceDiagnostic: CloudflareAccessAudienceDiagnostic | null;

  constructor(
    code: CloudflareAccessJwtErrorCode,
    audienceDiagnostic: CloudflareAccessAudienceDiagnostic | null = null,
  ) {
    super(code);
    this.name = "CloudflareAccessJwtError";
    this.code = code;
    this.audienceDiagnostic = audienceDiagnostic;
  }
}

export class CloudflareAccessSigningKeyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareAccessSigningKeyResolutionError";
  }
}

export interface CloudflareAccessSigningKeyResolver {
  resolveSigningKey(kid: string): Promise<JsonWebKey>;
}

export interface CloudflareAccessPrincipal {
  readonly subject: string;
  readonly email: string | null;
}

export interface CloudflareAccessJwtVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
}

interface JwtHeader {
  readonly alg: "RS256";
  readonly kid: string;
}

interface JwtClaims {
  readonly type: "app";
  readonly iss: string;
  readonly aud: readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly nbf: number | null;
  readonly subject: string;
  readonly email: string | null;
}

function fail(
  code: CloudflareAccessJwtErrorCode,
  audienceDiagnostic: CloudflareAccessAudienceDiagnostic | null = null,
): never {
  throw new CloudflareAccessJwtError(code, audienceDiagnostic);
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

function boundedOpaqueString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || hasControlCharacters(value)) {
    return null;
  }
  return value;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function audienceDiagnostic(value: unknown): Promise<CloudflareAccessAudienceDiagnostic> {
  if (typeof value === "string") {
    const bounded = boundedOpaqueString(value, MAX_AUDIENCE_LENGTH);
    return {
      shape: "STRING",
      count: 1,
      sha256: bounded ? [await sha256Hex(bounded)] : [],
    };
  }

  if (Array.isArray(value)) {
    const fingerprints: string[] = [];
    for (const entry of value) {
      if (fingerprints.length >= MAX_AUDIENCE_DIAGNOSTIC_FINGERPRINTS) break;
      const bounded = boundedOpaqueString(entry, MAX_AUDIENCE_LENGTH);
      if (bounded) fingerprints.push(await sha256Hex(bounded));
    }
    return {
      shape: "ARRAY",
      count: Math.min(value.length, MAX_AUDIENCE_DIAGNOSTIC_COUNT),
      sha256: fingerprints,
    };
  }

  return { shape: "OTHER", count: 0, sha256: [] };
}

function decodeBase64Url(segment: string, code: CloudflareAccessJwtErrorCode): Uint8Array {
  if (segment.length === 0 || segment.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(segment)) fail(code);

  const padded = `${segment.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (segment.length % 4)) % 4)}`;
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    fail(code);
  }
  if (binary.length > MAX_SEGMENT_BYTES) fail(code);

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function parseJsonSegment(segment: string, code: CloudflareAccessJwtErrorCode): unknown {
  const bytes = decodeBase64Url(segment, code);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    fail(code);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(code);
  }
}

function parseHeader(encodedHeader: string): JwtHeader {
  const raw = parseJsonSegment(encodedHeader, "ACCESS_JWT_HEADER_INVALID");
  if (!isRecord(raw) || raw.alg !== "RS256") fail("ACCESS_JWT_HEADER_INVALID");
  const kid = boundedOpaqueString(raw.kid, MAX_KID_LENGTH);
  if (!kid || !KID_PATTERN.test(kid)) fail("ACCESS_JWT_HEADER_INVALID");
  return { alg: "RS256", kid };
}

function normalizeIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("ACCESS_JWT_ISSUER_INVALID");
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
    fail("ACCESS_JWT_ISSUER_INVALID");
  }
  return url.origin;
}

function normalizeAudience(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_AUDIENCE_LENGTH ||
    hasControlCharacters(value) ||
    !AUDIENCE_PATTERN.test(value)
  ) {
    fail("ACCESS_JWT_AUDIENCE_INVALID");
  }
  return value;
}

function validateSigningJwk(jwk: JsonWebKey): JsonWebKey {
  if (
    !isRecord(jwk) ||
    jwk.kty !== "RSA" ||
    typeof jwk.n !== "string" ||
    jwk.n.length === 0 ||
    typeof jwk.e !== "string" ||
    jwk.e.length === 0 ||
    (jwk.alg !== undefined && jwk.alg !== "RS256") ||
    (jwk.use !== undefined && jwk.use !== "sig") ||
    (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify")))
  ) {
    fail("ACCESS_JWT_KEY_INVALID");
  }
  return jwk;
}

async function importSigningKey(jwk: JsonWebKey): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "jwk",
      validateSigningJwk(jwk),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch (error) {
    if (error instanceof CloudflareAccessJwtError) throw error;
    fail("ACCESS_JWT_KEY_INVALID");
  }
}

function requireSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) fail("ACCESS_JWT_CLAIMS_INVALID");
  return value as number;
}

async function parseClaims(
  encodedPayload: string,
  expectedIssuer: string,
  expectedAudience: string,
  nowSeconds: number,
): Promise<JwtClaims> {
  const raw = parseJsonSegment(encodedPayload, "ACCESS_JWT_CLAIMS_INVALID");
  if (!isRecord(raw) || raw.type !== "app") fail("ACCESS_JWT_CLAIMS_INVALID");

  if (raw.iss !== expectedIssuer) fail("ACCESS_JWT_ISSUER_INVALID");
  if (
    !Array.isArray(raw.aud) ||
    raw.aud.length === 0 ||
    raw.aud.some((value) => typeof value !== "string" || value.length === 0) ||
    !raw.aud.includes(expectedAudience)
  ) {
    fail("ACCESS_JWT_AUDIENCE_INVALID", await audienceDiagnostic(raw.aud));
  }

  const exp = requireSafeInteger(raw.exp);
  const iat = requireSafeInteger(raw.iat);
  if (exp <= iat) fail("ACCESS_JWT_CLAIMS_INVALID");
  if (exp <= nowSeconds) fail("ACCESS_JWT_EXPIRED");
  if (iat > nowSeconds) fail("ACCESS_JWT_ISSUED_IN_FUTURE");

  let nbf: number | null;
  let subject: string;
  let email: string | null = null;

  if (raw.sub === "") {
    const commonName = boundedOpaqueString(raw.common_name, MAX_SERVICE_TOKEN_COMMON_NAME_LENGTH);
    if (!commonName || raw.email !== undefined || raw.identity_nonce !== undefined) {
      fail("ACCESS_JWT_CLAIMS_INVALID");
    }

    nbf = raw.nbf === undefined ? null : requireSafeInteger(raw.nbf);
    subject = `${SERVICE_TOKEN_PRINCIPAL_PREFIX}${commonName}`;
  } else {
    const sub = boundedOpaqueString(raw.sub, MAX_PRINCIPAL_LENGTH);
    if (!sub || raw.common_name !== undefined) fail("ACCESS_JWT_CLAIMS_INVALID");

    nbf = requireSafeInteger(raw.nbf);
    subject = sub;

    if (raw.email !== undefined && raw.email !== null) {
      const candidate = boundedOpaqueString(raw.email, MAX_PRINCIPAL_LENGTH);
      if (!candidate || !candidate.includes("@")) fail("ACCESS_JWT_CLAIMS_INVALID");
      email = candidate;
    }
  }

  if (nbf !== null) {
    if (exp <= nbf) fail("ACCESS_JWT_CLAIMS_INVALID");
    if (nbf > nowSeconds) fail("ACCESS_JWT_NOT_YET_VALID");
  }

  return {
    type: "app",
    iss: expectedIssuer,
    aud: raw.aud as string[],
    exp,
    iat,
    nbf,
    subject,
    email,
  };
}

export class CloudflareAccessJwtVerifier {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #resolver: CloudflareAccessSigningKeyResolver;

  constructor(config: CloudflareAccessJwtVerifierConfig, resolver: CloudflareAccessSigningKeyResolver) {
    this.#issuer = normalizeIssuer(config.issuer);
    this.#audience = normalizeAudience(config.audience);
    this.#resolver = resolver;
  }

  async verifyRequest(request: Request, now = new Date()): Promise<CloudflareAccessPrincipal> {
    const token = request.headers.get(ACCESS_JWT_HEADER);
    if (!token) fail("ACCESS_JWT_MISSING");
    return this.verifyToken(token, now);
  }

  async verifyToken(token: string, now = new Date()): Promise<CloudflareAccessPrincipal> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || hasControlCharacters(token)) {
      fail("ACCESS_JWT_MALFORMED");
    }

    const segments = token.split(".");
    if (segments.length !== 3) fail("ACCESS_JWT_MALFORMED");
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    if (!encodedHeader || !encodedPayload || !encodedSignature) fail("ACCESS_JWT_MALFORMED");

    const header = parseHeader(encodedHeader);
    let jwk: JsonWebKey;
    try {
      jwk = await this.#resolver.resolveSigningKey(header.kid);
    } catch (error) {
      if (error instanceof CloudflareAccessSigningKeyResolutionError) throw error;
      fail("ACCESS_JWT_KEY_UNAVAILABLE");
    }
    const key = await importSigningKey(jwk);

    const signature = toArrayBuffer(decodeBase64Url(encodedSignature, "ACCESS_JWT_MALFORMED"));
    const signingInput = toArrayBuffer(new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
    let signatureValid = false;
    try {
      signatureValid = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        signature,
        signingInput,
      );
    } catch {
      fail("ACCESS_JWT_SIGNATURE_INVALID");
    }
    if (!signatureValid) fail("ACCESS_JWT_SIGNATURE_INVALID");

    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) fail("ACCESS_JWT_CLAIMS_INVALID");
    const claims = await parseClaims(encodedPayload, this.#issuer, this.#audience, Math.floor(nowMs / 1000));

    return { subject: claims.subject, email: claims.email };
  }
}
