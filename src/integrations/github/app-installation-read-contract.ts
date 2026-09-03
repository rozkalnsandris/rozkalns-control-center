import { requireManagedProjectPolicy } from "../../shared/project-policy.js";

export const GITHUB_REST_API_VERSION = "2026-03-10" as const;
export const GITHUB_INSTALLATION_TOKEN_MAX_REPOSITORIES = 500;
export const GITHUB_INSTALLATION_CREDENTIAL_MAX_LIFETIME_MS = 60 * 60 * 1000 + 5_000;
export const GITHUB_INSTALLATION_CREDENTIAL_MIN_REMAINING_MS = 60_000;

export const phase2GitHubReadPermissions = [
  "actions",
  "checks",
  "contents",
  "issues",
  "metadata",
  "pull_requests",
  "statuses",
] as const;

export type Phase2GitHubReadPermission = (typeof phase2GitHubReadPermissions)[number];

export const githubInstallationReadPermissions = [...phase2GitHubReadPermissions, "administration"] as const;
export type GitHubInstallationReadPermission = (typeof githubInstallationReadPermissions)[number];

export interface GitHubInstallationReadScope {
  installationId: number;
  repositories: readonly string[];
  permissions: Readonly<Partial<Record<GitHubInstallationReadPermission, "read">>>;
}

export interface GitHubCredentialLeaseEvidence {
  installationId: number;
  repositories: readonly string[];
  permissions: Readonly<Partial<Record<GitHubInstallationReadPermission, "read">>>;
  issuedAt: string;
  expiresAt: string;
}

export interface GitHubReadRequest {
  repository: string;
  path: string;
  requiredPermission: GitHubInstallationReadPermission;
  apiVersion: typeof GITHUB_REST_API_VERSION;
}

export interface GitHubRateLimitEvidence {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  resource: string | null;
}

export type GitHubReadPageOutcome =
  | { readonly kind: "OK"; readonly validator: string | null }
  | { readonly kind: "NOT_MODIFIED"; readonly validator: string };

export interface GitHubReadOptions {
  /** Explicitly limited to dashboard/background reads; mutation preflight callers omit this. */
  readonly cacheMode?: "READ_ONLY_CONDITIONAL";
}

export interface GitHubReadResult<T> {
  pages: readonly T[];
  credentialLease: GitHubCredentialLeaseEvidence;
  requestCount: number;
  rateLimit: GitHubRateLimitEvidence | null;
  /** Present for the concrete REST transport; optional for detached test/provider adapters. */
  pageOutcomes?: readonly GitHubReadPageOutcome[];
}

/**
 * The implementation owns credential minting and HTTP authentication internally.
 * Domain callers receive only redacted lease evidence and cannot supply headers or methods.
 * High-privilege read scopes remain opt-in: Phase 2 rollout helpers never add administration.
 */
export interface GitHubInstallationReadTransport {
  get<T>(
    scope: GitHubInstallationReadScope,
    request: GitHubReadRequest,
    observedAt: string,
    options?: GitHubReadOptions,
  ): Promise<GitHubReadResult<T>>;
}

const allowedPermissionNames = new Set<string>(githubInstallationReadPermissions);
const scopeKeys = new Set(["installationId", "repositories", "permissions"]);
const leaseKeys = new Set(["installationId", "repositories", "permissions", "issuedAt", "expiresAt"]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, allowedKeys: ReadonlySet<string>, label: string) {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function normalizeInstallationId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("GitHub installation id must be a positive safe integer");
  }
  return value as number;
}

function normalizeRepositories(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > GITHUB_INSTALLATION_TOKEN_MAX_REPOSITORIES) {
    throw new Error("GitHub installation repository scope must contain between 1 and 500 repositories");
  }

  const seen = new Set<string>();
  return value.map((candidate) => {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      throw new Error("GitHub installation repository scope contains an invalid repository");
    }

    const policy = requireManagedProjectPolicy(candidate);
    const normalized = policy.repository.toLowerCase();
    if (seen.has(normalized)) throw new Error(`Duplicate GitHub installation repository scope: ${policy.repository}`);
    seen.add(normalized);
    return policy.repository;
  });
}

function normalizePermissions(value: unknown): Readonly<Partial<Record<GitHubInstallationReadPermission, "read">>> {
  const record = requireRecord(value, "GitHub installation permission scope");
  const entries = Object.entries(record);
  if (entries.length === 0) throw new Error("GitHub installation permission scope must not be empty");

  const normalized: Partial<Record<GitHubInstallationReadPermission, "read">> = {};
  for (const [name, access] of entries) {
    if (!allowedPermissionNames.has(name)) {
      throw new Error(`GitHub installation permission is not approved for Control reads: ${name}`);
    }
    if (access !== "read") {
      throw new Error(`GitHub installation permission must remain read-only: ${name}`);
    }
    normalized[name as GitHubInstallationReadPermission] = "read";
  }
  return normalized;
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function sameRepositoryScope(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right.map((repository) => repository.toLowerCase()));
  return left.every((repository) => rightSet.has(repository.toLowerCase()));
}

function samePermissionScope(
  left: Readonly<Partial<Record<GitHubInstallationReadPermission, "read">>>,
  right: Readonly<Partial<Record<GitHubInstallationReadPermission, "read">>>,
) {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export function parseGitHubInstallationReadScope(input: unknown): GitHubInstallationReadScope {
  const record = requireRecord(input, "GitHub installation read scope");
  requireExactKeys(record, scopeKeys, "GitHub installation read scope");

  return {
    installationId: normalizeInstallationId(record.installationId),
    repositories: normalizeRepositories(record.repositories),
    permissions: normalizePermissions(record.permissions),
  };
}

export function parseGitHubCredentialLeaseEvidence(input: unknown): GitHubCredentialLeaseEvidence {
  const record = requireRecord(input, "GitHub credential lease evidence");
  requireExactKeys(record, leaseKeys, "GitHub credential lease evidence");

  const scope = parseGitHubInstallationReadScope({
    installationId: record.installationId,
    repositories: record.repositories,
    permissions: record.permissions,
  });
  const issuedAtMs = parseTimestamp(record.issuedAt, "GitHub credential issuedAt");
  const expiresAtMs = parseTimestamp(record.expiresAt, "GitHub credential expiresAt");

  if (expiresAtMs <= issuedAtMs) throw new Error("GitHub credential expiry must be after issuance");
  if (expiresAtMs - issuedAtMs > GITHUB_INSTALLATION_CREDENTIAL_MAX_LIFETIME_MS) {
    throw new Error("GitHub credential lifetime exceeds the short-lived installation-token contract");
  }

  return {
    ...scope,
    issuedAt: record.issuedAt as string,
    expiresAt: record.expiresAt as string,
  };
}

export function assertGitHubCredentialLeaseUsable(
  lease: GitHubCredentialLeaseEvidence,
  scope: GitHubInstallationReadScope,
  observedAt: string,
) {
  const normalizedLease = parseGitHubCredentialLeaseEvidence(lease);
  const observedAtMs = parseTimestamp(observedAt, "GitHub credential observation time");
  const expiresAtMs = Date.parse(normalizedLease.expiresAt);

  if (normalizedLease.installationId !== scope.installationId) {
    throw new Error("GitHub credential lease belongs to a different installation");
  }
  if (!sameRepositoryScope(normalizedLease.repositories, scope.repositories)) {
    throw new Error("GitHub credential lease repository scope does not match the requested scope");
  }
  if (!samePermissionScope(normalizedLease.permissions, scope.permissions)) {
    throw new Error("GitHub credential lease permission scope does not match the requested scope");
  }
  if (expiresAtMs - observedAtMs < GITHUB_INSTALLATION_CREDENTIAL_MIN_REMAINING_MS) {
    throw new Error("GitHub credential lease has insufficient remaining lifetime");
  }
}

export function createGitHubReadRequest(
  scope: GitHubInstallationReadScope,
  repository: string,
  path: string,
  requiredPermission: GitHubInstallationReadPermission,
): GitHubReadRequest {
  const policy = requireManagedProjectPolicy(repository);
  if (!scope.repositories.some((candidate) => candidate.toLowerCase() === policy.repository.toLowerCase())) {
    throw new Error("GitHub read request repository is outside the installation credential scope");
  }
  if (scope.permissions[requiredPermission] !== "read") {
    throw new Error(`GitHub read request permission is outside the installation credential scope: ${requiredPermission}`);
  }
  if (!path.startsWith("/") || path.includes("://") || /[\r\n]/.test(path)) {
    throw new Error("GitHub read request path must be a relative REST path");
  }

  const expectedRepositoryPrefix = `/repos/${policy.repository}`.toLowerCase();
  const normalizedPath = path.toLowerCase();
  if (normalizedPath !== expectedRepositoryPrefix && !normalizedPath.startsWith(`${expectedRepositoryPrefix}/`)) {
    throw new Error("GitHub read request path repository does not match the requested repository");
  }

  return {
    repository: policy.repository,
    path,
    requiredPermission,
    apiVersion: GITHUB_REST_API_VERSION,
  };
}
