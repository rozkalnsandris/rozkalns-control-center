import {
  GITHUB_REST_API_VERSION,
  assertGitHubCredentialLeaseUsable,
  parseGitHubCredentialLeaseEvidence,
  parseGitHubInstallationReadScope,
  type GitHubCredentialLeaseEvidence,
  type GitHubInstallationReadScope,
} from "./app-installation-read-contract.js";
import {
  GITHUB_REST_ACCEPT,
  GITHUB_REST_ORIGIN,
  type GitHubAuthorizedRestGet,
  type GitHubInstallationAuthorizedReadSession,
  type GitHubInstallationAuthorizedReadSessionProvider,
} from "./rest-read-transport.js";

export const GITHUB_APP_JWT_ALGORITHM = "RS256" as const;
export const GITHUB_APP_JWT_CLOCK_SKEW_SECONDS = 60;
export const GITHUB_APP_JWT_FUTURE_LIFETIME_SECONDS = 9 * 60;

export type GitHubAppSessionFailureCode =
  | "INVALID_APP_IDENTITY"
  | "INVALID_TIME"
  | "SIGNING_FAILED"
  | "TOKEN_EXCHANGE_FAILED"
  | "TOKEN_UNAUTHORIZED"
  | "TOKEN_FORBIDDEN"
  | "TOKEN_NOT_FOUND"
  | "TOKEN_SCOPE_REJECTED"
  | "TOKEN_MALFORMED_RESPONSE"
  | "TOKEN_SCOPE_MISMATCH"
  | "TOKEN_UNUSABLE"
  | "READ_REQUEST_INVALID"
  | "READ_TRANSPORT_FAILED";

const failureMessages: Readonly<Record<GitHubAppSessionFailureCode, string>> = {
  INVALID_APP_IDENTITY: "GitHub App identity failed validation",
  INVALID_TIME: "GitHub App credential observation time is invalid",
  SIGNING_FAILED: "GitHub App JWT signing failed",
  TOKEN_EXCHANGE_FAILED: "GitHub App installation token exchange failed",
  TOKEN_UNAUTHORIZED: "GitHub App installation token exchange is unauthorized",
  TOKEN_FORBIDDEN: "GitHub App installation token exchange is forbidden",
  TOKEN_NOT_FOUND: "GitHub App installation was not found",
  TOKEN_SCOPE_REJECTED: "GitHub App installation token scope was rejected",
  TOKEN_MALFORMED_RESPONSE: "GitHub App installation token response is malformed",
  TOKEN_SCOPE_MISMATCH: "GitHub App installation token scope does not match the requested scope",
  TOKEN_UNUSABLE: "GitHub App installation token lease is unusable",
  READ_REQUEST_INVALID: "GitHub App authorized read request failed validation",
  READ_TRANSPORT_FAILED: "GitHub App authorized read transport failed",
};

export class GitHubAppSessionError extends Error {
  readonly code: GitHubAppSessionFailureCode;
  readonly status: number | null;

  constructor(code: GitHubAppSessionFailureCode, status: number | null = null) {
    super(failureMessages[code]);
    this.name = "GitHubAppSessionError";
    this.code = code;
    this.status = status;
  }
}

export interface GitHubAppIdentity {
  readonly clientId: string;
}

/**
 * The signer owns access to private-key material outside this contract.
 * Callers provide only a signing input and receive signature bytes.
 */
export interface GitHubAppJwtSigner {
  signRs256(signingInput: Uint8Array): Promise<Uint8Array>;
}

/** Low-level dependency injection for deterministic tests. The module owns every Request it passes here. */
export type GitHubAppCredentialFetch = (request: Request) => Promise<Response>;

export interface GitHubAppInstallationSessionDependencies {
  readonly identity: GitHubAppIdentity;
  readonly signer: GitHubAppJwtSigner;
  readonly fetchRequest: GitHubAppCredentialFetch;
}

interface GitHubInstallationTokenResponseShape {
  readonly rawCredential: string;
  readonly expiresAt: string;
  readonly repositories: readonly string[];
  readonly permissions: unknown;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function normalizeClientId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || hasControlCharacters(value)) {
    throw new GitHubAppSessionError("INVALID_APP_IDENTITY");
  }
  return value;
}

function parseObservedAt(value: string): { readonly milliseconds: number; readonly iso: string } {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new GitHubAppSessionError("INVALID_TIME");
  return { milliseconds, iso: new Date(milliseconds).toISOString() };
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

async function createGitHubAppJwt(
  clientId: string,
  observedAtMs: number,
  signer: GitHubAppJwtSigner,
): Promise<string> {
  const observedAtSeconds = Math.floor(observedAtMs / 1000);
  const protectedHeader = base64UrlEncodeJson({ alg: GITHUB_APP_JWT_ALGORITHM, typ: "JWT" });
  const payload = base64UrlEncodeJson({
    iat: observedAtSeconds - GITHUB_APP_JWT_CLOCK_SKEW_SECONDS,
    exp: observedAtSeconds + GITHUB_APP_JWT_FUTURE_LIFETIME_SECONDS,
    iss: clientId,
  });
  const signingInput = `${protectedHeader}.${payload}`;

  let signature: Uint8Array;
  try {
    signature = await signer.signRs256(new TextEncoder().encode(signingInput));
  } catch {
    throw new GitHubAppSessionError("SIGNING_FAILED");
  }
  if (!(signature instanceof Uint8Array) || signature.byteLength === 0) {
    throw new GitHubAppSessionError("SIGNING_FAILED");
  }

  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

function repositoryName(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new GitHubAppSessionError("TOKEN_SCOPE_MISMATCH");
  }
  return parts[1];
}

function tokenEndpoint(installationId: number): string {
  return `${GITHUB_REST_ORIGIN}/app/installations/${installationId}/access_tokens`;
}

function tokenRequestBody(scope: GitHubInstallationReadScope): string {
  return JSON.stringify({
    repositories: scope.repositories.map(repositoryName),
    permissions: { ...scope.permissions },
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE");
  }
  return value as Record<string, unknown>;
}

function parseRepositoryEvidence(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE");
  }

  return value.map((candidate) => {
    const record = requireRecord(candidate);
    if (typeof record.full_name !== "string" || record.full_name.trim() === "") {
      throw new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE");
    }
    return record.full_name;
  });
}

function parseOpaqueCredential(value: unknown): string {
  if (typeof value !== "string" || value === "" || /[\r\n]/.test(value)) {
    throw new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE");
  }
  return value;
}

function parseExpiresAt(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE");
  }
  return value;
}

function parseTokenResponsePayload(input: unknown): GitHubInstallationTokenResponseShape {
  const record = requireRecord(input);
  return {
    rawCredential: parseOpaqueCredential(record.token),
    expiresAt: parseExpiresAt(record.expires_at),
    repositories: parseRepositoryEvidence(record.repositories),
    permissions: record.permissions,
  };
}

function assertJsonResponse(response: Response): void {
  const rawContentType = response.headers.get("content-type");
  if (rawContentType === null) throw new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE", response.status);
  const mediaType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE", response.status);
  }
}

function assertTokenStatus(response: Response): void {
  if (response.status === 201) return;
  if (response.status === 401) throw new GitHubAppSessionError("TOKEN_UNAUTHORIZED", response.status);
  if (response.status === 403) throw new GitHubAppSessionError("TOKEN_FORBIDDEN", response.status);
  if (response.status === 404) throw new GitHubAppSessionError("TOKEN_NOT_FOUND", response.status);
  if (response.status === 422) throw new GitHubAppSessionError("TOKEN_SCOPE_REJECTED", response.status);
  throw new GitHubAppSessionError("TOKEN_EXCHANGE_FAILED", response.status);
}

async function parseTokenResponse(response: Response): Promise<GitHubInstallationTokenResponseShape> {
  assertTokenStatus(response);
  assertJsonResponse(response);
  try {
    return parseTokenResponsePayload(await response.json());
  } catch (error) {
    if (error instanceof GitHubAppSessionError) throw error;
    throw new GitHubAppSessionError("TOKEN_MALFORMED_RESPONSE", response.status);
  }
}

function leaseFromTokenResponse(
  scope: GitHubInstallationReadScope,
  payload: GitHubInstallationTokenResponseShape,
  issuedAt: string,
): GitHubCredentialLeaseEvidence {
  let responseScope: GitHubInstallationReadScope;
  try {
    responseScope = parseGitHubInstallationReadScope({
      installationId: scope.installationId,
      repositories: payload.repositories,
      permissions: payload.permissions,
    });
  } catch {
    throw new GitHubAppSessionError("TOKEN_SCOPE_MISMATCH");
  }

  const requestedRepositories = new Set(scope.repositories.map((repository) => repository.toLowerCase()));
  const responseRepositories = new Set(responseScope.repositories.map((repository) => repository.toLowerCase()));
  const repositoryScopeMatches =
    requestedRepositories.size === responseRepositories.size &&
    [...requestedRepositories].every((repository) => responseRepositories.has(repository));

  const requestedPermissions = Object.entries(scope.permissions).sort(([left], [right]) => left.localeCompare(right));
  const responsePermissions = Object.entries(responseScope.permissions).sort(([left], [right]) => left.localeCompare(right));
  const permissionScopeMatches = JSON.stringify(requestedPermissions) === JSON.stringify(responsePermissions);
  if (!repositoryScopeMatches || !permissionScopeMatches) {
    throw new GitHubAppSessionError("TOKEN_SCOPE_MISMATCH");
  }

  try {
    return parseGitHubCredentialLeaseEvidence({
      installationId: scope.installationId,
      repositories: responseScope.repositories,
      permissions: responseScope.permissions,
      issuedAt,
      expiresAt: payload.expiresAt,
    });
  } catch {
    throw new GitHubAppSessionError("TOKEN_UNUSABLE");
  }
}

function assertAuthorizedReadRequest(request: GitHubAuthorizedRestGet, scope: GitHubInstallationReadScope): URL {
  if (
    request.method !== "GET" ||
    request.accept !== GITHUB_REST_ACCEPT ||
    request.apiVersion !== GITHUB_REST_API_VERSION ||
    request.redirect !== "manual"
  ) {
    throw new GitHubAppSessionError("READ_REQUEST_INVALID");
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new GitHubAppSessionError("READ_REQUEST_INVALID");
  }
  if (url.origin !== GITHUB_REST_ORIGIN || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new GitHubAppSessionError("READ_REQUEST_INVALID");
  }

  const pathname = url.pathname.toLowerCase();
  if (
    !scope.repositories.some((repository) => {
      const prefix = `/repos/${repository}`.toLowerCase();
      return pathname === prefix || pathname.startsWith(`${prefix}/`);
    })
  ) {
    throw new GitHubAppSessionError("READ_REQUEST_INVALID");
  }
  return url;
}

function createAuthorizedReadSession(
  scope: GitHubInstallationReadScope,
  lease: GitHubCredentialLeaseEvidence,
  rawCredential: string,
  fetchRequest: GitHubAppCredentialFetch,
): GitHubInstallationAuthorizedReadSession {
  return {
    credentialLease: lease,
    async execute(request: GitHubAuthorizedRestGet): Promise<Response> {
      const url = assertAuthorizedReadRequest(request, scope);
      let response: Response;
      try {
        response = await fetchRequest(
          new Request(url.href, {
            method: "GET",
            headers: {
              Accept: GITHUB_REST_ACCEPT,
              Authorization: `Bearer ${rawCredential}`,
              "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
            },
            redirect: "manual",
          }),
        );
      } catch {
        throw new GitHubAppSessionError("READ_TRANSPORT_FAILED");
      }
      return response;
    },
  };
}

export function createGitHubAppInstallationSessionProvider(
  dependencies: GitHubAppInstallationSessionDependencies,
): GitHubInstallationAuthorizedReadSessionProvider {
  const clientId = normalizeClientId(dependencies.identity.clientId);

  return async (scopeInput: GitHubInstallationReadScope, observedAt: string) => {
    let scope: GitHubInstallationReadScope;
    try {
      scope = parseGitHubInstallationReadScope(scopeInput);
    } catch {
      throw new GitHubAppSessionError("TOKEN_SCOPE_MISMATCH");
    }
    const observation = parseObservedAt(observedAt);
    const appJwt = await createGitHubAppJwt(clientId, observation.milliseconds, dependencies.signer);

    let response: Response;
    try {
      response = await dependencies.fetchRequest(
        new Request(tokenEndpoint(scope.installationId), {
          method: "POST",
          headers: {
            Accept: GITHUB_REST_ACCEPT,
            Authorization: `Bearer ${appJwt}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
          },
          body: tokenRequestBody(scope),
          redirect: "manual",
        }),
      );
    } catch {
      throw new GitHubAppSessionError("TOKEN_EXCHANGE_FAILED");
    }

    const payload = await parseTokenResponse(response);
    const lease = leaseFromTokenResponse(scope, payload, observation.iso);
    try {
      assertGitHubCredentialLeaseUsable(lease, scope, observation.iso);
    } catch {
      throw new GitHubAppSessionError("TOKEN_UNUSABLE");
    }

    return createAuthorizedReadSession(scope, lease, payload.rawCredential, dependencies.fetchRequest);
  };
}
