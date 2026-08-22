import { mapGitHubClassicBranchProtection } from "../../shared/github-classic-protection-mapper.js";
import type { BranchPolicyObservation } from "../../shared/github-policy-evidence.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import {
  createGitHubReadRequest,
  parseGitHubInstallationReadScope,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
} from "./app-installation-read-contract.js";
import { GitHubRestReadError } from "./rest-read-transport.js";

export type GitHubClassicBranchProtectionReaderFailureCode =
  | "INVALID_REQUEST"
  | "READ_FAILED"
  | "MALFORMED_RESPONSE";

const failureMessages: Readonly<Record<GitHubClassicBranchProtectionReaderFailureCode, string>> = {
  INVALID_REQUEST: "GitHub classic branch-protection read request failed validation",
  READ_FAILED: "GitHub classic branch-protection read failed closed",
  MALFORMED_RESPONSE: "GitHub classic branch-protection response is malformed",
};

export class GitHubClassicBranchProtectionReaderError extends Error {
  readonly code: GitHubClassicBranchProtectionReaderFailureCode;

  constructor(code: GitHubClassicBranchProtectionReaderFailureCode) {
    super(failureMessages[code]);
    this.name = "GitHubClassicBranchProtectionReaderError";
    this.code = code;
  }
}

export type GitHubClassicProtectionState = "PRESENT" | "ABSENT";

export interface GitHubClassicBranchProtectionObservation extends BranchPolicyObservation {
  readonly classicProtectionState: GitHubClassicProtectionState;
}

export interface GitHubClassicBranchProtectionReaderOptions {
  readonly scope: GitHubInstallationReadScope;
  readonly absenceScope: GitHubInstallationReadScope;
  readonly observedAt: string;
  readonly restTransport: GitHubInstallationReadTransport;
}

export interface GitHubClassicBranchProtectionReader {
  readonly scope: GitHubInstallationReadScope;
  readonly absenceScope: GitHubInstallationReadScope;
  readonly observedAt: string;
  readClassicBranchProtection(repository: string, branch: string): Promise<GitHubClassicBranchProtectionObservation>;
}

function invalid(): never {
  throw new GitHubClassicBranchProtectionReaderError("INVALID_REQUEST");
}

function readFailed(): never {
  throw new GitHubClassicBranchProtectionReaderError("READ_FAILED");
}

function malformed(): never {
  throw new GitHubClassicBranchProtectionReaderError("MALFORMED_RESPONSE");
}

function normalizeScope(value: GitHubInstallationReadScope): GitHubInstallationReadScope {
  try {
    const scope = parseGitHubInstallationReadScope(value);
    if (scope.permissions.administration !== "read") return invalid();
    return scope;
  } catch {
    return invalid();
  }
}

function normalizeAbsenceScope(
  value: GitHubInstallationReadScope,
  classicScope: GitHubInstallationReadScope,
): GitHubInstallationReadScope {
  try {
    const scope = parseGitHubInstallationReadScope(value);
    if (scope.permissions.contents !== "read") return invalid();
    if (Object.keys(scope.permissions).length !== 1) return invalid();
    if (scope.installationId !== classicScope.installationId) return invalid();
    if (
      scope.repositories.length !== classicScope.repositories.length ||
      scope.repositories.some((repository, index) => repository !== classicScope.repositories[index])
    ) {
      return invalid();
    }
    return scope;
  } catch {
    return invalid();
  }
}

function normalizeObservedAt(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) return invalid();
  return value;
}

function canonicalRepository(repository: string): string {
  try {
    return requireManagedProjectPolicy(repository).repository;
  } catch {
    return invalid();
  }
}

function normalizeBranch(branch: string): string {
  if (typeof branch !== "string" || branch.trim() === "" || /[\r\n]/.test(branch)) return invalid();
  return branch;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
}

function emptyClassicObservation(
  repository: string,
  branch: string,
  observedAt: string,
): GitHubClassicBranchProtectionObservation {
  return {
    source: "GITHUB_CLASSIC_BRANCH_PROTECTION",
    repository,
    branch,
    observedAt,
    requiredStatusChecks: [],
    hasUnresolvedRequiredCheckSourceIdentity: false,
    requiredApprovals: 0,
    reviewFeatures: {
      dismissStaleReviewsOnPush: false,
      requireCodeOwnerReview: false,
      requireLastPushApproval: false,
      requireReviewThreadResolution: false,
      hasRequiredFilePatternReviewers: false,
    },
    classicProtectionState: "ABSENT",
  };
}

function mapUnprotectedBranchMetadata(
  payload: unknown,
  repository: string,
  branch: string,
  observedAt: string,
): GitHubClassicBranchProtectionObservation {
  const root = requireObject(payload);
  if (root.name !== branch) return malformed();
  if (typeof root.protected !== "boolean") return malformed();
  if (root.protected !== false) return readFailed();

  if (Object.prototype.hasOwnProperty.call(root, "protection")) {
    const protection = requireObject(root.protection);
    if (typeof protection.enabled !== "boolean") return malformed();
    if (protection.enabled !== false) return readFailed();
  }

  return emptyClassicObservation(repository, branch, observedAt);
}

function classicNotFound(error: unknown): boolean {
  return error instanceof GitHubRestReadError && error.code === "NOT_FOUND" && error.status === 404;
}

export function createGitHubClassicBranchProtectionReader(
  options: GitHubClassicBranchProtectionReaderOptions,
): GitHubClassicBranchProtectionReader {
  const scope = normalizeScope(options.scope);
  const absenceScope = normalizeAbsenceScope(options.absenceScope, scope);
  const observedAt = normalizeObservedAt(options.observedAt);
  const restTransport = options.restTransport;

  async function readAbsenceProof(
    repository: string,
    branch: string,
    encodedBranch: string,
  ): Promise<GitHubClassicBranchProtectionObservation> {
    let request;
    try {
      request = createGitHubReadRequest(
        absenceScope,
        repository,
        `/repos/${repository}/branches/${encodedBranch}`,
        "contents",
      );
    } catch {
      return invalid();
    }

    let pages: readonly unknown[];
    try {
      pages = (await restTransport.get<unknown>(absenceScope, request, observedAt)).pages;
    } catch {
      return readFailed();
    }
    if (!Array.isArray(pages) || pages.length !== 1) return malformed();
    return mapUnprotectedBranchMetadata(pages[0], repository, branch, observedAt);
  }

  return {
    scope,
    absenceScope,
    observedAt,

    async readClassicBranchProtection(
      repositoryInput: string,
      branchInput: string,
    ): Promise<GitHubClassicBranchProtectionObservation> {
      const repository = canonicalRepository(repositoryInput);
      const branch = normalizeBranch(branchInput);
      const encodedBranch = encodeURIComponent(branch);

      let request;
      try {
        request = createGitHubReadRequest(
          scope,
          repository,
          `/repos/${repository}/branches/${encodedBranch}/protection`,
          "administration",
        );
      } catch {
        return invalid();
      }

      let pages: readonly unknown[];
      try {
        pages = (await restTransport.get<unknown>(scope, request, observedAt)).pages;
      } catch (error) {
        if (classicNotFound(error)) {
          return readAbsenceProof(repository, branch, encodedBranch);
        }
        throw error;
      }

      if (!Array.isArray(pages) || pages.length !== 1) return malformed();

      try {
        return {
          ...mapGitHubClassicBranchProtection(pages[0], repository, branch, observedAt),
          classicProtectionState: "PRESENT",
        };
      } catch {
        return malformed();
      }
    },
  };
}
