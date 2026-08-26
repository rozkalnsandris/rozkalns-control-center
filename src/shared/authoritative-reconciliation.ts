import type { DecisionReadModel, DeployImpact } from "./control-model.js";
import {
  deriveProjectionPolicies,
  type BranchPolicyCoverage,
  type BranchPolicyEvidence,
  type BranchPolicySource,
} from "./github-policy-evidence.js";
import { projectAuthoritativeSnapshotToDecision } from "./github-projection.js";
import { requireManagedProjectPolicy } from "./project-policy.js";
import {
  readAuthoritativePullRequestSnapshot,
  type CommitStatusEvidenceCoverage,
  type IssueRead,
  type SourceControlReadProvider,
} from "./source-control-read.js";

export type AuthoritativeReconciliationFailureCode =
  | "INVALID_REQUEST"
  | "ISSUE_NOT_FOUND"
  | "MALFORMED_EVIDENCE";

const failureMessages: Readonly<Record<AuthoritativeReconciliationFailureCode, string>> = {
  INVALID_REQUEST: "Authoritative reconciliation request failed validation",
  ISSUE_NOT_FOUND: "Authoritative reconciliation issue was not found in the open-issue read",
  MALFORMED_EVIDENCE: "Authoritative reconciliation evidence is inconsistent",
};

export class AuthoritativeReconciliationError extends Error {
  readonly code: AuthoritativeReconciliationFailureCode;

  constructor(code: AuthoritativeReconciliationFailureCode) {
    super(failureMessages[code]);
    this.name = "AuthoritativeReconciliationError";
    this.code = code;
  }
}

export interface BranchPolicyEvidenceReader {
  readBranchPolicyEvidence(repository: string, branch: string, observedAt: string): Promise<BranchPolicyEvidence>;
}

export interface AuthoritativeReconciliationRequest {
  readonly provider: SourceControlReadProvider;
  readonly branchPolicyReader: BranchPolicyEvidenceReader;
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly observedAt: string;
  readonly commitStatusCoverage?: CommitStatusEvidenceCoverage;
  readonly deployImpact?: DeployImpact;
}

export interface AuthoritativePolicySummary {
  readonly coverage: BranchPolicyCoverage;
  readonly sources: readonly BranchPolicySource[];
  readonly blockedReasons: readonly string[];
}

export interface BlockedAuthoritativeReconciliationResult {
  readonly kind: "BLOCKED";
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly observedAt: string;
  readonly defaultBranch: string;
  readonly mainSha: string;
  readonly headSha: string;
  readonly commitStatusCoverage: CommitStatusEvidenceCoverage;
  readonly policy: AuthoritativePolicySummary;
}

export interface ProjectedAuthoritativeReconciliationResult {
  readonly kind: "PROJECTED";
  readonly repository: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly observedAt: string;
  readonly commitStatusCoverage: CommitStatusEvidenceCoverage;
  readonly policy: AuthoritativePolicySummary & { readonly coverage: "COMPLETE" };
  readonly decision: DecisionReadModel;
}

export type AuthoritativeReconciliationResult =
  | BlockedAuthoritativeReconciliationResult
  | ProjectedAuthoritativeReconciliationResult;

const deployImpacts = new Set<DeployImpact>([
  "NO_DEPLOY",
  "AUTO_DEPLOY_SAFE",
  "MANUAL_ROLLOUT_REQUIRED",
  "DB_HOST_APPLY_REQUIRED",
  "UNKNOWN",
]);

function invalid(): never {
  throw new AuthoritativeReconciliationError("INVALID_REQUEST");
}

function malformed(): never {
  throw new AuthoritativeReconciliationError("MALFORMED_EVIDENCE");
}

function canonicalRepository(repository: string): string {
  try {
    return requireManagedProjectPolicy(repository).repository;
  } catch {
    return invalid();
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return invalid();
  return value;
}

function normalizedObservedAt(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) return invalid();
  return value;
}

function normalizedDeployImpact(value: DeployImpact | undefined): DeployImpact {
  if (value === undefined) return "UNKNOWN";
  if (!deployImpacts.has(value)) return invalid();
  return value;
}

function exactOpenIssue(issues: readonly IssueRead[], issueNumber: number): IssueRead {
  const matches = issues.filter((issue) => issue.number === issueNumber);
  if (matches.length === 0) throw new AuthoritativeReconciliationError("ISSUE_NOT_FOUND");
  if (matches.length !== 1) return malformed();

  const issue = matches[0];
  if (issue.state !== "open") return malformed();
  return issue;
}

function validatePolicyIdentity(
  evidence: BranchPolicyEvidence,
  repository: string,
  defaultBranch: string,
  observedAt: string,
): void {
  if (evidence.repository.toLowerCase() !== repository.toLowerCase()) malformed();
  if (evidence.branch !== defaultBranch) malformed();
  if (evidence.observedAt !== observedAt) malformed();
  if (evidence.coverage !== "UNKNOWN" && evidence.coverage !== "PARTIAL" && evidence.coverage !== "COMPLETE") {
    malformed();
  }
}

function policySummary(evidence: BranchPolicyEvidence, blockedReasons: readonly string[]): AuthoritativePolicySummary {
  return {
    coverage: evidence.coverage,
    sources: [...evidence.sources],
    blockedReasons: [...blockedReasons],
  };
}

export async function reconcileAuthoritativePullRequestDecision(
  request: AuthoritativeReconciliationRequest,
): Promise<AuthoritativeReconciliationResult> {
  const repository = canonicalRepository(request.repository);
  const issueNumber = positiveInteger(request.issueNumber);
  const pullNumber = positiveInteger(request.pullNumber);
  const observedAt = normalizedObservedAt(request.observedAt);
  const deployImpact = normalizedDeployImpact(request.deployImpact);

  const [snapshot, openIssues] = await Promise.all([
    readAuthoritativePullRequestSnapshot(request.provider, repository, pullNumber, observedAt, {
      commitStatusCoverage: request.commitStatusCoverage,
    }),
    request.provider.listOpenIssues(repository),
  ]);

  if (snapshot.repository.toLowerCase() !== repository.toLowerCase()) malformed();
  if (snapshot.observedAt !== observedAt) malformed();
  const issue = exactOpenIssue(openIssues, issueNumber);

  const policyEvidence = await request.branchPolicyReader.readBranchPolicyEvidence(
    repository,
    snapshot.defaultBranch,
    observedAt,
  );
  validatePolicyIdentity(policyEvidence, repository, snapshot.defaultBranch, observedAt);

  const derived = deriveProjectionPolicies(policyEvidence, snapshot.mergeState.reviewThreadResolution);
  const blockedReasons = [...derived.blockedReasons];
  if (!derived.ciPolicy || !derived.reviewPolicy) {
    if (!blockedReasons.includes("PROJECTION_POLICY_UNAVAILABLE")) {
      blockedReasons.push("PROJECTION_POLICY_UNAVAILABLE");
    }
  }

  if (blockedReasons.length > 0 || policyEvidence.coverage !== "COMPLETE") {
    if (policyEvidence.coverage !== "COMPLETE" && !blockedReasons.includes("BRANCH_POLICY_COVERAGE_INCOMPLETE")) {
      blockedReasons.push("BRANCH_POLICY_COVERAGE_INCOMPLETE");
    }

    return {
      kind: "BLOCKED",
      repository,
      issueNumber,
      pullNumber,
      observedAt,
      defaultBranch: snapshot.defaultBranch,
      mainSha: snapshot.mainSha,
      headSha: snapshot.pullRequest.headSha,
      commitStatusCoverage: snapshot.commitStatusCoverage,
      policy: policySummary(policyEvidence, blockedReasons),
    };
  }

  const decision = projectAuthoritativeSnapshotToDecision(snapshot, {
    issue,
    ciPolicy: derived.ciPolicy,
    reviewPolicy: derived.reviewPolicy,
    deployImpact,
  });

  return {
    kind: "PROJECTED",
    repository,
    issueNumber,
    pullNumber,
    observedAt,
    commitStatusCoverage: snapshot.commitStatusCoverage,
    policy: {
      coverage: "COMPLETE",
      sources: [...policyEvidence.sources],
      blockedReasons: [],
    },
    decision,
  };
}
