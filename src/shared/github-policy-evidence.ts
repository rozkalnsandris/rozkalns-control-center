import type { CiRequirementPolicy, ReviewRequirementPolicy } from "./github-projection.js";

export type BranchPolicySource = "GITHUB_ACTIVE_RULES" | "GITHUB_CLASSIC_BRANCH_PROTECTION";
export type BranchPolicyCoverage = "UNKNOWN" | "PARTIAL" | "COMPLETE";

export interface RequiredStatusCheckPolicyRead {
  context: string;
  integrationId: number | null;
}

export interface ReviewPolicyFeaturesRead {
  dismissStaleReviewsOnPush: boolean;
  requireCodeOwnerReview: boolean;
  requireLastPushApproval: boolean;
  requireReviewThreadResolution: boolean;
  hasRequiredFilePatternReviewers: boolean;
}

export interface BranchPolicyObservation {
  source: BranchPolicySource;
  repository: string;
  branch: string;
  observedAt: string;
  requiredStatusChecks: readonly RequiredStatusCheckPolicyRead[];
  requiredApprovals: number;
  reviewFeatures: ReviewPolicyFeaturesRead;
}

export interface BranchPolicyEvidence {
  repository: string;
  branch: string;
  observedAt: string;
  coverage: BranchPolicyCoverage;
  sources: readonly BranchPolicySource[];
  requiredStatusChecks: readonly RequiredStatusCheckPolicyRead[];
  requiredApprovals: number;
  reviewFeatures: ReviewPolicyFeaturesRead;
}

export interface ProjectionPolicyDerivation {
  ciPolicy?: CiRequirementPolicy;
  reviewPolicy?: ReviewRequirementPolicy;
  blockedReasons: readonly string[];
}

interface GitHubActiveBranchRule {
  type: string;
  ruleset_source_type?: unknown;
  ruleset_source?: unknown;
  ruleset_id?: unknown;
  parameters?: unknown;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function readOptionalRequiredReviewers(parameters: Record<string, unknown>): boolean {
  if (!("required_reviewers" in parameters) || parameters.required_reviewers == null) return false;
  if (!Array.isArray(parameters.required_reviewers)) {
    throw new Error("pull_request.parameters.required_reviewers must be an array when present");
  }
  return parameters.required_reviewers.length > 0;
}

function mapRequiredStatusChecks(parametersValue: unknown): RequiredStatusCheckPolicyRead[] {
  const parameters = requireObject(parametersValue, "required_status_checks.parameters");
  if (!Array.isArray(parameters.required_status_checks)) {
    throw new Error("required_status_checks.parameters.required_status_checks must be an array");
  }

  const byContext = new Map<string, RequiredStatusCheckPolicyRead>();
  for (const [index, value] of parameters.required_status_checks.entries()) {
    const item = requireObject(value, `required_status_checks[${index}]`);
    const context = requireNonEmptyString(item.context, `required_status_checks[${index}].context`);
    const rawIntegrationId = item.integration_id;
    const integrationId =
      rawIntegrationId == null
        ? null
        : requireNonNegativeInteger(rawIntegrationId, `required_status_checks[${index}].integration_id`);

    const key = context.toLowerCase();
    const existing = byContext.get(key);
    if (existing && existing.integrationId !== integrationId) {
      throw new Error(`Conflicting required status-check source for context ${context}`);
    }
    byContext.set(key, { context, integrationId });
  }

  return [...byContext.values()].sort((a, b) => a.context.localeCompare(b.context));
}

function mergeRequiredChecks(
  existing: Map<string, RequiredStatusCheckPolicyRead>,
  incoming: readonly RequiredStatusCheckPolicyRead[],
): void {
  for (const check of incoming) {
    const key = check.context.toLowerCase();
    const previous = existing.get(key);
    if (previous && previous.integrationId !== check.integrationId) {
      throw new Error(`Conflicting required status-check source for context ${check.context}`);
    }
    existing.set(key, check);
  }
}

const emptyReviewFeatures = (): ReviewPolicyFeaturesRead => ({
  dismissStaleReviewsOnPush: false,
  requireCodeOwnerReview: false,
  requireLastPushApproval: false,
  requireReviewThreadResolution: false,
  hasRequiredFilePatternReviewers: false,
});

function mergeReviewFeatures(target: ReviewPolicyFeaturesRead, incoming: ReviewPolicyFeaturesRead): void {
  target.dismissStaleReviewsOnPush ||= incoming.dismissStaleReviewsOnPush;
  target.requireCodeOwnerReview ||= incoming.requireCodeOwnerReview;
  target.requireLastPushApproval ||= incoming.requireLastPushApproval;
  target.requireReviewThreadResolution ||= incoming.requireReviewThreadResolution;
  target.hasRequiredFilePatternReviewers ||= incoming.hasRequiredFilePatternReviewers;
}

function mapPullRequestRule(parametersValue: unknown): {
  requiredApprovals: number;
  reviewFeatures: ReviewPolicyFeaturesRead;
} {
  const parameters = requireObject(parametersValue, "pull_request.parameters");
  return {
    requiredApprovals: requireNonNegativeInteger(
      parameters.required_approving_review_count,
      "pull_request.parameters.required_approving_review_count",
    ),
    reviewFeatures: {
      dismissStaleReviewsOnPush: requireBoolean(
        parameters.dismiss_stale_reviews_on_push,
        "pull_request.parameters.dismiss_stale_reviews_on_push",
      ),
      requireCodeOwnerReview: requireBoolean(
        parameters.require_code_owner_review,
        "pull_request.parameters.require_code_owner_review",
      ),
      requireLastPushApproval: requireBoolean(
        parameters.require_last_push_approval,
        "pull_request.parameters.require_last_push_approval",
      ),
      requireReviewThreadResolution: requireBoolean(
        parameters.required_review_thread_resolution,
        "pull_request.parameters.required_review_thread_resolution",
      ),
      hasRequiredFilePatternReviewers: readOptionalRequiredReviewers(parameters),
    },
  };
}

export function mapGitHubActiveBranchRules(
  payload: unknown,
  repository: string,
  branch: string,
  observedAt: string,
): BranchPolicyObservation {
  if (!Array.isArray(payload)) throw new Error("GitHub active branch rules payload must be an array");
  requireNonEmptyString(repository, "repository");
  requireNonEmptyString(branch, "branch");
  requireNonEmptyString(observedAt, "observedAt");

  const requiredChecks = new Map<string, RequiredStatusCheckPolicyRead>();
  let requiredApprovals = 0;
  const reviewFeatures = emptyReviewFeatures();

  for (const [index, value] of payload.entries()) {
    const rule = requireObject(value, `rules[${index}]`) as unknown as GitHubActiveBranchRule;
    const type = requireNonEmptyString(rule.type, `rules[${index}].type`);

    if (type === "required_status_checks") {
      mergeRequiredChecks(requiredChecks, mapRequiredStatusChecks(rule.parameters));
      continue;
    }

    if (type === "pull_request") {
      const mapped = mapPullRequestRule(rule.parameters);
      requiredApprovals = Math.max(requiredApprovals, mapped.requiredApprovals);
      mergeReviewFeatures(reviewFeatures, mapped.reviewFeatures);
    }
  }

  return {
    source: "GITHUB_ACTIVE_RULES",
    repository,
    branch,
    observedAt,
    requiredStatusChecks: [...requiredChecks.values()].sort((a, b) => a.context.localeCompare(b.context)),
    requiredApprovals,
    reviewFeatures,
  };
}

export function combineBranchPolicyObservations(
  observations: readonly BranchPolicyObservation[],
  repository: string,
  branch: string,
  observedAt: string,
): BranchPolicyEvidence {
  requireNonEmptyString(repository, "repository");
  requireNonEmptyString(branch, "branch");
  requireNonEmptyString(observedAt, "observedAt");

  const sourceSet = new Set<BranchPolicySource>();
  const requiredChecks = new Map<string, RequiredStatusCheckPolicyRead>();
  let requiredApprovals = 0;
  const reviewFeatures = emptyReviewFeatures();

  for (const observation of observations) {
    if (observation.repository.toLowerCase() !== repository.toLowerCase()) {
      throw new Error("Branch policy observation repository mismatch");
    }
    if (observation.branch !== branch) throw new Error("Branch policy observation branch mismatch");
    if (observation.observedAt !== observedAt) {
      throw new Error("Branch policy observation timestamp mismatch");
    }
    if (sourceSet.has(observation.source)) {
      throw new Error(`Duplicate branch policy observation source ${observation.source}`);
    }
    sourceSet.add(observation.source);
    mergeRequiredChecks(requiredChecks, observation.requiredStatusChecks);
    requiredApprovals = Math.max(requiredApprovals, observation.requiredApprovals);
    mergeReviewFeatures(reviewFeatures, observation.reviewFeatures);
  }

  const expectedSources: BranchPolicySource[] = ["GITHUB_ACTIVE_RULES", "GITHUB_CLASSIC_BRANCH_PROTECTION"];
  const coverage: BranchPolicyCoverage =
    sourceSet.size === 0
      ? "UNKNOWN"
      : expectedSources.every((source) => sourceSet.has(source))
        ? "COMPLETE"
        : "PARTIAL";

  return {
    repository,
    branch,
    observedAt,
    coverage,
    sources: [...sourceSet].sort(),
    requiredStatusChecks: [...requiredChecks.values()].sort((a, b) => a.context.localeCompare(b.context)),
    requiredApprovals,
    reviewFeatures,
  };
}

export function deriveProjectionPolicies(evidence: BranchPolicyEvidence): ProjectionPolicyDerivation {
  const blockedReasons: string[] = [];
  if (evidence.coverage !== "COMPLETE") blockedReasons.push("BRANCH_POLICY_COVERAGE_INCOMPLETE");

  const sourceBoundChecks = evidence.requiredStatusChecks.filter((check) => check.integrationId !== null);
  if (sourceBoundChecks.length > 0) blockedReasons.push("REQUIRED_CHECK_SOURCE_IDENTITY_NOT_MODELED");

  const reviewFeatures = evidence.reviewFeatures;
  if (reviewFeatures.dismissStaleReviewsOnPush) blockedReasons.push("DISMISS_STALE_REVIEWS_NOT_MODELED");
  if (reviewFeatures.requireCodeOwnerReview) blockedReasons.push("CODE_OWNER_REVIEW_NOT_MODELED");
  if (reviewFeatures.requireLastPushApproval) blockedReasons.push("LAST_PUSH_APPROVAL_NOT_MODELED");
  if (reviewFeatures.requireReviewThreadResolution) blockedReasons.push("REVIEW_THREAD_RESOLUTION_NOT_MODELED");
  if (reviewFeatures.hasRequiredFilePatternReviewers) blockedReasons.push("FILE_PATTERN_REVIEWERS_NOT_MODELED");

  if (blockedReasons.length > 0) return { blockedReasons };

  return {
    ciPolicy: {
      requiredCheckNames: evidence.requiredStatusChecks.map((check) => check.context),
      requiredWorkflowNames: [],
    },
    reviewPolicy: { requiredApprovals: evidence.requiredApprovals },
    blockedReasons,
  };
}
