import type {
  BranchPolicyObservation,
  RequiredStatusCheckPolicyRead,
  ReviewPolicyFeaturesRead,
} from "./github-policy-evidence.js";

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

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireApprovalCount(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 6) {
    throw new Error(`${label} must be an integer from 0 to 6`);
  }
  return value as number;
}

function readClassicAppId(
  item: Record<string, unknown>,
  label: string,
): { integrationId: number | null; sourceIdentityKnown: boolean } {
  if (!Object.prototype.hasOwnProperty.call(item, "app_id")) {
    return { integrationId: null, sourceIdentityKnown: false };
  }

  const value = item.app_id;
  if (value === null || value === -1) {
    return { integrationId: null, sourceIdentityKnown: true };
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label}.app_id must be null, -1, or a positive integer`);
  }
  return { integrationId: value as number, sourceIdentityKnown: true };
}

function insertRequiredCheck(
  byContext: Map<string, RequiredStatusCheckPolicyRead>,
  context: string,
  integrationId: number | null,
): void {
  const key = context.toLowerCase();
  const existing = byContext.get(key);
  if (existing && existing.integrationId !== integrationId) {
    throw new Error(`Conflicting classic required status-check source for context ${context}`);
  }
  if (!existing) byContext.set(key, { context, integrationId });
}

function mapClassicRequiredStatusChecks(value: unknown): {
  requiredStatusChecks: RequiredStatusCheckPolicyRead[];
  hasUnresolvedRequiredCheckSourceIdentity: boolean;
} {
  if (value == null) {
    return { requiredStatusChecks: [], hasUnresolvedRequiredCheckSourceIdentity: false };
  }

  const object = requireObject(value, "required_status_checks");
  const byContext = new Map<string, RequiredStatusCheckPolicyRead>();
  let hasUnresolvedRequiredCheckSourceIdentity = false;
  let sawChecks = false;
  let sawContexts = false;

  if (Object.prototype.hasOwnProperty.call(object, "checks")) {
    if (!Array.isArray(object.checks)) throw new Error("required_status_checks.checks must be an array");
    sawChecks = true;

    for (const [index, raw] of object.checks.entries()) {
      const item = requireObject(raw, `required_status_checks.checks[${index}]`);
      const context = requireNonEmptyString(item.context, `required_status_checks.checks[${index}].context`);
      const app = readClassicAppId(item, `required_status_checks.checks[${index}]`);
      insertRequiredCheck(byContext, context, app.integrationId);
      hasUnresolvedRequiredCheckSourceIdentity ||= !app.sourceIdentityKnown;
    }
  }

  if (Object.prototype.hasOwnProperty.call(object, "contexts")) {
    if (!Array.isArray(object.contexts)) throw new Error("required_status_checks.contexts must be an array");
    sawContexts = true;

    for (const [index, raw] of object.contexts.entries()) {
      const context = requireNonEmptyString(raw, `required_status_checks.contexts[${index}]`);
      const key = context.toLowerCase();
      if (!byContext.has(key)) {
        insertRequiredCheck(byContext, context, null);
        hasUnresolvedRequiredCheckSourceIdentity = true;
      }
    }
  }

  if (!sawChecks && !sawContexts) {
    throw new Error("required_status_checks must include checks or contexts");
  }

  return {
    requiredStatusChecks: [...byContext.values()].sort((a, b) => a.context.localeCompare(b.context)),
    hasUnresolvedRequiredCheckSourceIdentity,
  };
}

function emptyReviewFeatures(): ReviewPolicyFeaturesRead {
  return {
    dismissStaleReviewsOnPush: false,
    requireCodeOwnerReview: false,
    requireLastPushApproval: false,
    requireReviewThreadResolution: false,
    hasRequiredFilePatternReviewers: false,
  };
}

function mapClassicPullRequestReviews(value: unknown): {
  requiredApprovals: number;
  reviewFeatures: ReviewPolicyFeaturesRead;
} {
  if (value == null) return { requiredApprovals: 0, reviewFeatures: emptyReviewFeatures() };

  const object = requireObject(value, "required_pull_request_reviews");
  return {
    requiredApprovals: requireApprovalCount(
      object.required_approving_review_count,
      "required_pull_request_reviews.required_approving_review_count",
    ),
    reviewFeatures: {
      dismissStaleReviewsOnPush: requireBoolean(
        object.dismiss_stale_reviews,
        "required_pull_request_reviews.dismiss_stale_reviews",
      ),
      requireCodeOwnerReview: requireBoolean(
        object.require_code_owner_reviews,
        "required_pull_request_reviews.require_code_owner_reviews",
      ),
      requireLastPushApproval: requireBoolean(
        object.require_last_push_approval,
        "required_pull_request_reviews.require_last_push_approval",
      ),
      requireReviewThreadResolution: false,
      hasRequiredFilePatternReviewers: false,
    },
  };
}

function readConversationResolution(value: unknown): boolean {
  if (value == null) return false;
  const object = requireObject(value, "required_conversation_resolution");
  return requireBoolean(object.enabled, "required_conversation_resolution.enabled");
}

export function mapGitHubClassicBranchProtection(
  payload: unknown,
  repository: string,
  branch: string,
  observedAt: string,
): BranchPolicyObservation {
  const root = requireObject(payload, "classic branch protection payload");
  requireNonEmptyString(repository, "repository");
  requireNonEmptyString(branch, "branch");
  requireNonEmptyString(observedAt, "observedAt");

  const checks = mapClassicRequiredStatusChecks(root.required_status_checks);
  const reviews = mapClassicPullRequestReviews(root.required_pull_request_reviews);
  reviews.reviewFeatures.requireReviewThreadResolution = readConversationResolution(
    root.required_conversation_resolution,
  );

  return {
    source: "GITHUB_CLASSIC_BRANCH_PROTECTION",
    repository,
    branch,
    observedAt,
    requiredStatusChecks: checks.requiredStatusChecks,
    hasUnresolvedRequiredCheckSourceIdentity: checks.hasUnresolvedRequiredCheckSourceIdentity,
    requiredApprovals: reviews.requiredApprovals,
    reviewFeatures: reviews.reviewFeatures,
  };
}
