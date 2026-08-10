import assert from "node:assert/strict";
import test from "node:test";

import {
  combineBranchPolicyObservations,
  deriveProjectionPolicies,
  mapGitHubActiveBranchRules,
  type BranchPolicyObservation,
} from "../src/shared/github-policy-evidence.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const BRANCH = "main";
const OBSERVED_AT = "2026-08-10T15:55:00Z";

function simplePullRequestRule(overrides: Record<string, unknown> = {}) {
  return {
    type: "pull_request",
    ruleset_source_type: "Repository",
    ruleset_source: REPOSITORY,
    ruleset_id: 42,
    parameters: {
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: false,
      ...overrides,
    },
  };
}

function classicObservation(overrides: Partial<BranchPolicyObservation> = {}): BranchPolicyObservation {
  return {
    source: "GITHUB_CLASSIC_BRANCH_PROTECTION",
    repository: REPOSITORY,
    branch: BRANCH,
    observedAt: OBSERVED_AT,
    requiredStatusChecks: [],
    requiredApprovals: 0,
    reviewFeatures: {
      dismissStaleReviewsOnPush: false,
      requireCodeOwnerReview: false,
      requireLastPushApproval: false,
      requireReviewThreadResolution: false,
      hasRequiredFilePatternReviewers: false,
    },
    ...overrides,
  };
}

test("active branch rules mapper deduplicates checks and keeps the strictest simple approval count", () => {
  const observation = mapGitHubActiveBranchRules(
    [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "validate", integration_id: null },
            { context: "Validate", integration_id: null },
            { context: "security", integration_id: null },
          ],
          strict_required_status_checks_policy: true,
        },
      },
      simplePullRequestRule({ required_approving_review_count: 1 }),
      simplePullRequestRule({ required_approving_review_count: 2 }),
      { type: "non_fast_forward" },
    ],
    REPOSITORY,
    BRANCH,
    OBSERVED_AT,
  );

  assert.equal(observation.source, "GITHUB_ACTIVE_RULES");
  assert.deepEqual(
    observation.requiredStatusChecks.map((check) => check.context.toLowerCase()),
    ["security", "validate"],
  );
  assert.equal(observation.requiredApprovals, 2);
  assert.deepEqual(observation.reviewFeatures, {
    dismissStaleReviewsOnPush: false,
    requireCodeOwnerReview: false,
    requireLastPushApproval: false,
    requireReviewThreadResolution: false,
    hasRequiredFilePatternReviewers: false,
  });
});

test("ruleset-only observation remains partial while classic branch protection is unverified", () => {
  const rulesetObservation = mapGitHubActiveBranchRules(
    [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "validate", integration_id: null }],
          strict_required_status_checks_policy: true,
        },
      },
      simplePullRequestRule(),
    ],
    REPOSITORY,
    BRANCH,
    OBSERVED_AT,
  );

  const evidence = combineBranchPolicyObservations([rulesetObservation], REPOSITORY, BRANCH, OBSERVED_AT);
  assert.equal(evidence.coverage, "PARTIAL");
  assert.deepEqual(evidence.sources, ["GITHUB_ACTIVE_RULES"]);

  const derived = deriveProjectionPolicies(evidence);
  assert.equal(derived.ciPolicy, undefined);
  assert.equal(derived.reviewPolicy, undefined);
  assert.deepEqual(derived.blockedReasons, ["BRANCH_POLICY_COVERAGE_INCOMPLETE"]);
});

test("complete simple evidence derives the existing projection policies conservatively", () => {
  const rulesetObservation = mapGitHubActiveBranchRules(
    [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "validate", integration_id: null }],
          strict_required_status_checks_policy: true,
        },
      },
      simplePullRequestRule(),
    ],
    REPOSITORY,
    BRANCH,
    OBSERVED_AT,
  );

  const evidence = combineBranchPolicyObservations(
    [rulesetObservation, classicObservation()],
    REPOSITORY,
    BRANCH,
    OBSERVED_AT,
  );

  assert.equal(evidence.coverage, "COMPLETE");
  const derived = deriveProjectionPolicies(evidence);
  assert.deepEqual(derived.blockedReasons, []);
  assert.deepEqual(derived.ciPolicy, { requiredCheckNames: ["validate"], requiredWorkflowNames: [] });
  assert.deepEqual(derived.reviewPolicy, { requiredApprovals: 1 });
});

test("source-bound required checks cannot be reduced to a name-only CI policy", () => {
  const rulesetObservation = mapGitHubActiveBranchRules(
    [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "validate", integration_id: 15368 }],
          strict_required_status_checks_policy: true,
        },
      },
      simplePullRequestRule(),
    ],
    REPOSITORY,
    BRANCH,
    OBSERVED_AT,
  );

  const evidence = combineBranchPolicyObservations(
    [rulesetObservation, classicObservation()],
    REPOSITORY,
    BRANCH,
    OBSERVED_AT,
  );
  const derived = deriveProjectionPolicies(evidence);

  assert.equal(derived.ciPolicy, undefined);
  assert.equal(derived.reviewPolicy, undefined);
  assert.deepEqual(derived.blockedReasons, ["REQUIRED_CHECK_SOURCE_IDENTITY_NOT_MODELED"]);
});

test("complex review rules remain fail-closed instead of fabricating a simple approval policy", () => {
  const rulesetObservation = mapGitHubActiveBranchRules(
    [
      simplePullRequestRule({
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: true,
        require_last_push_approval: true,
        required_review_thread_resolution: true,
        required_reviewers: [
          {
            reviewer: { id: 1, type: "Team" },
            minimum_approvals: 1,
            file_patterns: ["src/**"],
          },
        ],
      }),
    ],
    REPOSITORY,
    BRANCH,
    OBSERVED_AT,
  );

  const evidence = combineBranchPolicyObservations(
    [rulesetObservation, classicObservation()],
    REPOSITORY,
    BRANCH,
    OBSERVED_AT,
  );
  const derived = deriveProjectionPolicies(evidence);

  assert.equal(derived.reviewPolicy, undefined);
  assert.deepEqual(derived.blockedReasons, [
    "DISMISS_STALE_REVIEWS_NOT_MODELED",
    "CODE_OWNER_REVIEW_NOT_MODELED",
    "LAST_PUSH_APPROVAL_NOT_MODELED",
    "REVIEW_THREAD_RESOLUTION_NOT_MODELED",
    "FILE_PATTERN_REVIEWERS_NOT_MODELED",
  ]);
});

test("conflicting check source identities and malformed consumed rules fail closed", () => {
  assert.throws(
    () =>
      mapGitHubActiveBranchRules(
        [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "validate", integration_id: 1 },
                { context: "validate", integration_id: 2 },
              ],
              strict_required_status_checks_policy: true,
            },
          },
        ],
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /Conflicting required status-check source/,
  );

  assert.throws(
    () =>
      mapGitHubActiveBranchRules(
        [simplePullRequestRule({ required_approving_review_count: -1 })],
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /non-negative integer/,
  );

  assert.throws(
    () =>
      mapGitHubActiveBranchRules(
        [simplePullRequestRule({ require_code_owner_review: "yes" })],
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /must be a boolean/,
  );
});

test("evidence combiner rejects duplicate, mismatched and mixed-time observations", () => {
  const rulesetObservation = mapGitHubActiveBranchRules([], REPOSITORY, BRANCH, OBSERVED_AT);

  assert.throws(
    () =>
      combineBranchPolicyObservations(
        [rulesetObservation, rulesetObservation],
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /Duplicate branch policy observation source/,
  );

  assert.throws(
    () =>
      combineBranchPolicyObservations(
        [rulesetObservation],
        "rozkalnsandris/hermes-deals",
        BRANCH,
        OBSERVED_AT,
      ),
    /repository mismatch/,
  );

  assert.throws(
    () => combineBranchPolicyObservations([rulesetObservation], REPOSITORY, "release", OBSERVED_AT),
    /branch mismatch/,
  );

  assert.throws(
    () =>
      combineBranchPolicyObservations(
        [rulesetObservation, classicObservation({ observedAt: "2026-08-10T15:56:00Z" })],
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /timestamp mismatch/,
  );
});
