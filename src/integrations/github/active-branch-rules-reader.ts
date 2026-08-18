import {
  combineBranchPolicyObservations,
  mapGitHubActiveBranchRules,
  type BranchPolicyEvidence,
  type BranchPolicyObservation,
} from "../../shared/github-policy-evidence.js";
import { requireManagedProjectPolicy } from "../../shared/project-policy.js";
import {
  createGitHubReadRequest,
  parseGitHubInstallationReadScope,
  type GitHubInstallationReadScope,
  type GitHubInstallationReadTransport,
} from "./app-installation-read-contract.js";

export type GitHubActiveBranchRulesReaderFailureCode = "INVALID_REQUEST" | "MALFORMED_RESPONSE";

const failureMessages: Readonly<Record<GitHubActiveBranchRulesReaderFailureCode, string>> = {
  INVALID_REQUEST: "GitHub active branch-rules read request failed validation",
  MALFORMED_RESPONSE: "GitHub active branch-rules response is malformed",
};

export class GitHubActiveBranchRulesReaderError extends Error {
  readonly code: GitHubActiveBranchRulesReaderFailureCode;

  constructor(code: GitHubActiveBranchRulesReaderFailureCode) {
    super(failureMessages[code]);
    this.name = "GitHubActiveBranchRulesReaderError";
    this.code = code;
  }
}

export interface GitHubActiveBranchRulesObservation extends BranchPolicyObservation {
  readonly activeRuleCount: number;
}

export interface GitHubActiveBranchRulesReaderOptions {
  readonly scope: GitHubInstallationReadScope;
  readonly observedAt: string;
  readonly restTransport: GitHubInstallationReadTransport;
}

export interface GitHubActiveBranchRulesReader {
  readonly scope: GitHubInstallationReadScope;
  readonly observedAt: string;
  readActiveBranchRules(repository: string, branch: string): Promise<GitHubActiveBranchRulesObservation>;
  readPartialBranchPolicyEvidence(repository: string, branch: string): Promise<BranchPolicyEvidence>;
}

export interface GitHubActiveBranchPolicyEvidenceOptions extends GitHubActiveBranchRulesReaderOptions {
  readonly repository: string;
  readonly branch: string;
}

function invalid(): never {
  throw new GitHubActiveBranchRulesReaderError("INVALID_REQUEST");
}

function malformed(): never {
  throw new GitHubActiveBranchRulesReaderError("MALFORMED_RESPONSE");
}

function normalizeScope(value: GitHubInstallationReadScope): GitHubInstallationReadScope {
  try {
    return parseGitHubInstallationReadScope(value);
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

function flattenArrayPages(pages: readonly unknown[]): readonly unknown[] {
  const values: unknown[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) return malformed();
    values.push(...page);
  }
  return values;
}

export function createGitHubActiveBranchRulesReader(
  options: GitHubActiveBranchRulesReaderOptions,
): GitHubActiveBranchRulesReader {
  const scope = normalizeScope(options.scope);
  const observedAt = normalizeObservedAt(options.observedAt);
  const restTransport = options.restTransport;

  async function readActiveBranchRules(
    repositoryInput: string,
    branchInput: string,
  ): Promise<GitHubActiveBranchRulesObservation> {
    const repository = canonicalRepository(repositoryInput);
    const branch = normalizeBranch(branchInput);
    const encodedBranch = encodeURIComponent(branch);

    let request;
    try {
      request = createGitHubReadRequest(
        scope,
        repository,
        `/repos/${repository}/rules/branches/${encodedBranch}?per_page=100`,
        "metadata",
      );
    } catch {
      return invalid();
    }

    const pages = (await restTransport.get<unknown>(scope, request, observedAt)).pages;
    const rules = flattenArrayPages(pages);

    try {
      return {
        ...mapGitHubActiveBranchRules(rules, repository, branch, observedAt),
        activeRuleCount: rules.length,
      };
    } catch {
      return malformed();
    }
  }

  return {
    scope,
    observedAt,
    readActiveBranchRules,

    async readPartialBranchPolicyEvidence(repositoryInput: string, branchInput: string): Promise<BranchPolicyEvidence> {
      const repository = canonicalRepository(repositoryInput);
      const branch = normalizeBranch(branchInput);
      const observation = await readActiveBranchRules(repository, branch);

      try {
        return combineBranchPolicyObservations([observation], repository, branch, observedAt);
      } catch {
        return malformed();
      }
    },
  };
}

export async function readGitHubActiveBranchPolicyEvidence(
  options: GitHubActiveBranchPolicyEvidenceOptions,
): Promise<BranchPolicyEvidence> {
  const reader = createGitHubActiveBranchRulesReader(options);
  return reader.readPartialBranchPolicyEvidence(options.repository, options.branch);
}
