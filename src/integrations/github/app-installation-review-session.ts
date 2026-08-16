import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import {
  GITHUB_INSTALLATION_CREDENTIAL_MAX_LIFETIME_MS,
  GITHUB_INSTALLATION_CREDENTIAL_MIN_REMAINING_MS,
  GITHUB_REST_API_VERSION,
} from "./app-installation-read-contract.js";
import {
  GITHUB_APP_JWT_ALGORITHM,
  GITHUB_APP_JWT_CLOCK_SKEW_SECONDS,
  GITHUB_APP_JWT_FUTURE_LIFETIME_SECONDS,
  type GitHubAppCredentialFetch,
  type GitHubAppIdentity,
  type GitHubAppJwtSigner,
} from "./app-installation-session.js";
import {
  GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
  GITHUB_REQUEST_CHANGES_EVENT,
  type GitHubAuthorizedRestPost,
  type GitHubInstallationAuthorizedPullRequestWriteSession,
  type GitHubInstallationAuthorizedPullRequestWriteSessionProvider,
  type GitHubPullRequestWriteScope,
} from "./pull-request-review-write.js";
import { GITHUB_REST_ACCEPT, GITHUB_REST_ORIGIN } from "./rest-read-transport.js";

export type GitHubAppPullRequestWriteSessionFailureCode =
  | "INVALID_APP_IDENTITY"
  | "INVALID_INSTALLATION_ID"
  | "INVALID_SCOPE"
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
  | "WRITE_REQUEST_INVALID"
  | "WRITE_TRANSPORT_FAILED";

const failureMessages: Readonly<Record<GitHubAppPullRequestWriteSessionFailureCode, string>> = {
  INVALID_APP_IDENTITY: "GitHub App identity failed validation",
  INVALID_INSTALLATION_ID: "GitHub App installation id failed validation",
  INVALID_SCOPE: "GitHub App pull-request write scope failed validation",
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
  WRITE_REQUEST_INVALID: "GitHub App authorized pull-request write request failed validation",
  WRITE_TRANSPORT_FAILED: "GitHub App authorized pull-request write transport failed",
};

export class GitHubAppPullRequestWriteSessionError extends Error {
  readonly code: GitHubAppPullRequestWriteSessionFailureCode;
  readonly status: number | null;

  constructor(code: GitHubAppPullRequestWriteSessionFailureCode, status: number | null = null) {
    super(failureMessages[code]);
    this.name = "GitHubAppPullRequestWriteSessionError";
    this.code = code;
    this.status = status;
  }
}

export interface GitHubAppPullRequestWriteSessionDependencies {
  readonly identity: GitHubAppIdentity;
  readonly signer: GitHubAppJwtSigner;
  readonly fetchRequest: GitHubAppCredentialFetch;
}

export interface GitHubPullRequestWriteCredentialLeaseEvidence {
  readonly installationId: number;
  readonly repository: string;
  readonly permission: typeof GITHUB_PULL_REQUESTS_WRITE_PERMISSION;
  readonly metadataPermission: "read" | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface GitHubAppAuthorizedPullRequestWriteSession
  extends GitHubInstallationAuthorizedPullRequestWriteSession {
  readonly credentialLease: GitHubPullRequestWriteCredentialLeaseEvidence;
}

interface TokenResponseShape {
  readonly rawCredential: string;
  readonly expiresAt: string;
  readonly repositories: readonly string[];
  readonly metadataPermission: "read" | null;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function normalizeClientId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || hasControlCharacters(value)) {
    throw new GitHubAppPullRequestWriteSessionError("INVALID_APP_IDENTITY");
  }
  return value;
}

function normalizeInstallationId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new GitHubAppPullRequestWriteSessionError("INVALID_INSTALLATION_ID");
  }
  return value as number;
}

function normalizeScope(input: GitHubPullRequestWriteScope): GitHubPullRequestWriteScope {
  if (!input || typeof input !== "object" || input.permission !== GITHUB_PULL_REQUESTS_WRITE_PERMISSION) {
    throw new GitHubAppPullRequestWriteSessionError("INVALID_SCOPE");
  }
  try {
    return {
      repository: requireManagedProjectPolicy(input.repository).repository,
      permission: GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
    };
  } catch {
    throw new GitHubAppPullRequestWriteSessionError("INVALID_SCOPE");
  }
}

function parseObservedAt(value: string): { readonly milliseconds: number; readonly iso: string } {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GitHubAppPullRequestWriteSessionError("INVALID_TIME");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new GitHubAppPullRequestWriteSessionError("INVALID_TIME");
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

async function createAppJwt(
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
    throw new GitHubAppPullRequestWriteSessionError("SIGNING_FAILED");
  }
  if (!(signature instanceof Uint8Array) || signature.byteLength === 0) {
    throw new GitHubAppPullRequestWriteSessionError("SIGNING_FAILED");
  }
  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

function tokenEndpoint(installationId: number): string {
  return `${GITHUB_REST_ORIGIN}/app/installations/${installationId}/access_tokens`;
}

function repositoryName(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts[1] === "") throw new GitHubAppPullRequestWriteSessionError("INVALID_SCOPE");
  return parts[1];
}

function tokenRequestBody(scope: GitHubPullRequestWriteScope): string {
  return JSON.stringify({
    repositories: [repositoryName(scope.repository)],
    permissions: { pull_requests: "write" },
  });
}

function requireRecord(value: unknown, status: number | null = null): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_MALFORMED_RESPONSE", status);
  }
  return value as Record<string, unknown>;
}

function parseOpaqueCredential(value: unknown, status: number): string {
  if (typeof value !== "string" || value === "" || /[\r\n]/.test(value)) {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_MALFORMED_RESPONSE", status);
  }
  return value;
}

function parseExpiresAt(value: unknown, status: number): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_MALFORMED_RESPONSE", status);
  }
  return new Date(value).toISOString();
}

function parseRepositories(value: unknown, status: number): readonly string[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_SCOPE_MISMATCH", status);
  }
  return value.map((candidate) => {
    const record = requireRecord(candidate, status);
    if (typeof record.full_name !== "string" || record.full_name.trim() === "") {
      throw new GitHubAppPullRequestWriteSessionError("TOKEN_MALFORMED_RESPONSE", status);
    }
    return record.full_name;
  });
}

function parsePermissions(value: unknown, status: number): "read" | null {
  const permissions = requireRecord(value, status);
  const allowedKeys = new Set(["pull_requests", "metadata"]);
  for (const key of Object.keys(permissions)) {
    if (!allowedKeys.has(key)) {
      throw new GitHubAppPullRequestWriteSessionError("TOKEN_SCOPE_MISMATCH", status);
    }
  }
  if (permissions.pull_requests !== "write") {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_SCOPE_MISMATCH", status);
  }
  if (Object.hasOwn(permissions, "metadata") && permissions.metadata !== "read") {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_SCOPE_MISMATCH", status);
  }
  return permissions.metadata === "read" ? "read" : null;
}

function assertJsonResponse(response: Response): void {
  const raw = response.headers.get("content-type");
  if (raw === null) throw new GitHubAppPullRequestWriteSessionError("TOKEN_MALFORMED_RESPONSE", response.status);
  const mediaType = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_MALFORMED_RESPONSE", response.status);
  }
}

function assertTokenStatus(response: Response): void {
  if (response.status === 201) return;
  if (response.status === 401) throw new GitHubAppPullRequestWriteSessionError("TOKEN_UNAUTHORIZED", response.status);
  if (response.status === 403) throw new GitHubAppPullRequestWriteSessionError("TOKEN_FORBIDDEN", response.status);
  if (response.status === 404) throw new GitHubAppPullRequestWriteSessionError("TOKEN_NOT_FOUND", response.status);
  if (response.status === 422) throw new GitHubAppPullRequestWriteSessionError("TOKEN_SCOPE_REJECTED", response.status);
  throw new GitHubAppPullRequestWriteSessionError("TOKEN_EXCHANGE_FAILED", response.status);
}

async function parseTokenResponse(response: Response): Promise<TokenResponseShape> {
  assertTokenStatus(response);
  assertJsonResponse(response);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_MALFORMED_RESPONSE", response.status);
  }
  const record = requireRecord(payload, response.status);
  return {
    rawCredential: parseOpaqueCredential(record.token, response.status),
    expiresAt: parseExpiresAt(record.expires_at, response.status),
    repositories: parseRepositories(record.repositories, response.status),
    metadataPermission: parsePermissions(record.permissions, response.status),
  };
}

function createLease(
  installationId: number,
  scope: GitHubPullRequestWriteScope,
  payload: TokenResponseShape,
  issuedAt: string,
): GitHubPullRequestWriteCredentialLeaseEvidence {
  if (payload.repositories[0]?.toLowerCase() !== scope.repository.toLowerCase()) {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_SCOPE_MISMATCH");
  }
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(payload.expiresAt);
  if (
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > GITHUB_INSTALLATION_CREDENTIAL_MAX_LIFETIME_MS ||
    expiresAtMs - issuedAtMs < GITHUB_INSTALLATION_CREDENTIAL_MIN_REMAINING_MS
  ) {
    throw new GitHubAppPullRequestWriteSessionError("TOKEN_UNUSABLE");
  }
  return {
    installationId,
    repository: scope.repository,
    permission: GITHUB_PULL_REQUESTS_WRITE_PERMISSION,
    metadataPermission: payload.metadataPermission,
    issuedAt,
    expiresAt: payload.expiresAt,
  };
}

function expectedReviewPath(repository: string): RegExp {
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^/repos/${escapedRepository}/pulls/[1-9][0-9]*/reviews$`, "i");
}

function assertAuthorizedWriteRequest(request: GitHubAuthorizedRestPost, scope: GitHubPullRequestWriteScope): URL {
  if (
    request.method !== "POST" ||
    request.accept !== GITHUB_REST_ACCEPT ||
    request.apiVersion !== GITHUB_REST_API_VERSION ||
    request.contentType !== "application/json" ||
    request.redirect !== "manual" ||
    request.requiredPermission !== GITHUB_PULL_REQUESTS_WRITE_PERMISSION
  ) {
    throw new GitHubAppPullRequestWriteSessionError("WRITE_REQUEST_INVALID");
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new GitHubAppPullRequestWriteSessionError("WRITE_REQUEST_INVALID");
  }
  if (
    url.origin !== GITHUB_REST_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !expectedReviewPath(scope.repository).test(url.pathname)
  ) {
    throw new GitHubAppPullRequestWriteSessionError("WRITE_REQUEST_INVALID");
  }

  let body: unknown;
  try {
    body = JSON.parse(request.body);
  } catch {
    throw new GitHubAppPullRequestWriteSessionError("WRITE_REQUEST_INVALID");
  }
  const record = requireRecord(body);
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["body", "commit_id", "event"])) {
    throw new GitHubAppPullRequestWriteSessionError("WRITE_REQUEST_INVALID");
  }
  if (
    record.event !== GITHUB_REQUEST_CHANGES_EVENT ||
    typeof record.commit_id !== "string" ||
    !/^[0-9a-f]{40}$/.test(record.commit_id) ||
    typeof record.body !== "string" ||
    record.body.trim() === ""
  ) {
    throw new GitHubAppPullRequestWriteSessionError("WRITE_REQUEST_INVALID");
  }
  return url;
}

function createAuthorizedSession(
  scope: GitHubPullRequestWriteScope,
  lease: GitHubPullRequestWriteCredentialLeaseEvidence,
  rawCredential: string,
  fetchRequest: GitHubAppCredentialFetch,
): GitHubAppAuthorizedPullRequestWriteSession {
  let consumed = false;
  return {
    credentialLease: lease,
    async execute(request: GitHubAuthorizedRestPost): Promise<Response> {
      if (consumed) throw new GitHubAppPullRequestWriteSessionError("WRITE_REQUEST_INVALID");
      const url = assertAuthorizedWriteRequest(request, scope);
      consumed = true;
      try {
        return await fetchRequest(
          new Request(url.href, {
            method: "POST",
            headers: {
              Accept: GITHUB_REST_ACCEPT,
              Authorization: `Bearer ${rawCredential}`,
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
            },
            body: request.body,
            redirect: "manual",
          }),
        );
      } catch {
        throw new GitHubAppPullRequestWriteSessionError("WRITE_TRANSPORT_FAILED");
      }
    },
  };
}

export function createGitHubAppPullRequestWriteSessionProvider(
  dependencies: GitHubAppPullRequestWriteSessionDependencies,
  installationIdInput: number,
): GitHubInstallationAuthorizedPullRequestWriteSessionProvider {
  const clientId = normalizeClientId(dependencies.identity.clientId);
  const installationId = normalizeInstallationId(installationIdInput);

  return async (scopeInput, observedAt) => {
    const scope = normalizeScope(scopeInput);
    const observation = parseObservedAt(observedAt);
    const appJwt = await createAppJwt(clientId, observation.milliseconds, dependencies.signer);

    let response: Response;
    try {
      response = await dependencies.fetchRequest(
        new Request(tokenEndpoint(installationId), {
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
      throw new GitHubAppPullRequestWriteSessionError("TOKEN_EXCHANGE_FAILED");
    }

    const payload = await parseTokenResponse(response);
    const lease = createLease(installationId, scope, payload, observation.iso);
    return createAuthorizedSession(scope, lease, payload.rawCredential, dependencies.fetchRequest);
  };
}
