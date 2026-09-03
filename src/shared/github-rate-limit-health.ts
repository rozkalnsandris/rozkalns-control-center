export type GitHubRateLimitHealthStatus = "HEALTHY" | "ATTENTION" | "EXHAUSTED" | "UNKNOWN";

export interface GitHubRateLimitEvidenceLike {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly used: number | null;
  readonly resetAt: string | null;
  readonly resource: string | null;
}

export interface GitHubRateLimitHealth {
  readonly status: GitHubRateLimitHealthStatus;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly used: number | null;
  readonly resetAt: string | null;
  readonly resource: string | null;
  readonly observedAt: string | null;
}

const UNKNOWN_HEALTH: GitHubRateLimitHealth = Object.freeze({
  status: "UNKNOWN",
  limit: null,
  remaining: null,
  used: null,
  resetAt: null,
  resource: null,
  observedAt: null,
});

function canonicalIso(value: string): string | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value ? normalized : null;
}

function validCount(value: number | null): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function normalizeGitHubRateLimitHealth(
  evidence: GitHubRateLimitEvidenceLike | null,
  observedAt: string,
): GitHubRateLimitHealth {
  if (evidence === null) return UNKNOWN_HEALTH;
  const normalizedObservedAt = canonicalIso(observedAt);
  const normalizedResetAt = evidence.resetAt === null ? null : canonicalIso(evidence.resetAt);
  if (
    normalizedObservedAt === null ||
    normalizedResetAt === null ||
    !validCount(evidence.limit) ||
    evidence.limit <= 0 ||
    !validCount(evidence.remaining) ||
    !validCount(evidence.used) ||
    evidence.remaining > evidence.limit ||
    evidence.used > evidence.limit ||
    typeof evidence.resource !== "string" ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(evidence.resource)
  ) {
    return UNKNOWN_HEALTH;
  }

  const status: GitHubRateLimitHealthStatus = evidence.remaining === 0
    ? "EXHAUSTED"
    : evidence.remaining <= 50 || evidence.remaining / evidence.limit <= 0.1
      ? "ATTENTION"
      : "HEALTHY";

  return {
    status,
    limit: evidence.limit,
    remaining: evidence.remaining,
    used: evidence.used,
    resetAt: normalizedResetAt,
    resource: evidence.resource,
    observedAt: normalizedObservedAt,
  };
}

export function aggregateGitHubRateLimitHealth(
  evidence: readonly GitHubRateLimitEvidenceLike[],
  observedAt: string,
): GitHubRateLimitHealth {
  const candidates = evidence
    .map((candidate) => normalizeGitHubRateLimitHealth(candidate, observedAt))
    .filter((candidate) => candidate.status !== "UNKNOWN");
  if (candidates.length === 0) return UNKNOWN_HEALTH;
  return candidates.reduce((lowest, candidate) =>
    (candidate.remaining ?? Number.POSITIVE_INFINITY) < (lowest.remaining ?? Number.POSITIVE_INFINITY)
      ? candidate
      : lowest,
  );
}

export function isGitHubRateLimitHealth(value: unknown): value is GitHubRateLimitHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expectedKeys = ["limit", "observedAt", "remaining", "resetAt", "resource", "status", "used"];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)) return false;
  if (!new Set(["HEALTHY", "ATTENTION", "EXHAUSTED", "UNKNOWN"]).has(String(record.status))) return false;
  const nullableSafeInteger = (candidate: unknown) =>
    candidate === null || (Number.isSafeInteger(candidate) && (candidate as number) >= 0);
  const nullableString = (candidate: unknown) => candidate === null || typeof candidate === "string";
  if (!(
    nullableSafeInteger(record.limit) &&
    nullableSafeInteger(record.remaining) &&
    nullableSafeInteger(record.used) &&
    nullableString(record.resetAt) &&
    nullableString(record.resource) &&
    nullableString(record.observedAt)
  )) return false;
  if (record.status === "UNKNOWN") {
    return expectedKeys.filter((key) => key !== "status").every((key) => record[key] === null);
  }
  if (
    typeof record.limit !== "number" ||
    typeof record.remaining !== "number" ||
    typeof record.used !== "number" ||
    typeof record.resetAt !== "string" ||
    typeof record.resource !== "string" ||
    typeof record.observedAt !== "string"
  ) return false;
  const normalized = normalizeGitHubRateLimitHealth({
    limit: record.limit,
    remaining: record.remaining,
    used: record.used,
    resetAt: record.resetAt,
    resource: record.resource,
  }, record.observedAt);
  return (
    normalized.status === record.status &&
    normalized.limit === record.limit &&
    normalized.remaining === record.remaining &&
    normalized.used === record.used &&
    normalized.resetAt === record.resetAt &&
    normalized.resource === record.resource &&
    normalized.observedAt === record.observedAt
  );
}
