import { mapGitHubClassicBranchProtection } from "../../shared/github-classic-protection-mapper.js";
import type { BranchPolicyObservation } from "../../shared/github-policy-evidence.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import {
  createGitHubReadRequest,
  parseGitHubInstallationReadScope,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
} from "./app-installation-read-contract.js";

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

export interface GitHubClassicBranchProtectionReaderOptions {
  readonly scope: GitHubInstallationReadScope;
  readonly observedAt: string;
  readonly restTransport: GitHubInstallationReadTransport;
}

export interface GitHubClassicBranchProtectionReader {
  readonly scope: GitHubInstallationReadScope;
  readonly observedAt: string;
  readClassicBranchProtection(repository: string, branch: string): Promise<BranchPolicyObservation>;
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

export function createGitHubClassicBranchProtectionReader(
  options: GitHubClassicBranchProtectionReaderOptions,
): GitHubClassicBranchProtectionReader {
  const scope = normalizeScope(options.scope);
  const observedAt = normalizeObservedAt(options.observedAt);
  const restTransport = options.restTransport;

  return {
    scope,
    observedAt,

    async readClassicBranchProtection(repositoryInput: string, branchInput: string): Promise<BranchPolicyObservation> {
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
      } catch {
        return readFailed();
      }

      if (!Array.isArray(pages) || pages.length !== 1) return malformed();

      try {
        return mapGitHubClassicBranchProtection(pages[0], repository, branch, observedAt);
      } catch {
        return malformed();
      }
    },
  };
}
