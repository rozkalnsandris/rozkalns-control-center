import type {
  PullRequestMergeability,
  PullRequestMergeStateRead,
  PullRequestMergeStateStatus,
} from "./source-control-read.js";

const mergeabilityValues = new Set<PullRequestMergeability>(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);
const mergeStateValues = new Set<PullRequestMergeStateStatus>([
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a 40-character commit SHA`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${label} contains an unsupported value`);
  }
  return value as T;
}

export function mapGitHubGraphqlPullRequestMergeState(payload: unknown): PullRequestMergeStateRead {
  const value = requireObject(payload, "GitHub GraphQL pull request merge state");

  return {
    pullNumber: requirePositiveInteger(value.number, "GitHub GraphQL pull request number"),
    headSha: requireSha(value.headRefOid, "GitHub GraphQL pull request headRefOid"),
    mergeable: requireEnum(value.mergeable, mergeabilityValues, "GitHub GraphQL mergeable"),
    mergeStateStatus: requireEnum(value.mergeStateStatus, mergeStateValues, "GitHub GraphQL mergeStateStatus"),
    draft: requireBoolean(value.isDraft, "GitHub GraphQL isDraft"),
  };
}
