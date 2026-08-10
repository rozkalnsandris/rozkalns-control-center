import assert from "node:assert/strict";
import test from "node:test";

import { mapGitHubClassicBranchProtection } from "../src/shared/github-classic-protection-mapper.js";
import {
  combineBranchPolicyObservations,
  deriveProjectionPolicies,
  mapGitHubActiveBranchRules,
} from "../src/shared/github-policy-evidence.js";

const REPOSITORY = "rozkalnsandris/hermes-tech";
const BRANCH = "main";
const OBSERVED_AT = "2026-08-10T20:30:00Z";

function simpleReviews(overrides: Record<string, unknown> = {}) {
  return {
    required_approving_review_count: 1,
    dismiss_stale_reviews: false,
    require_code_owner_reviews: false,
    require_last_push_approval: false,
    ...overrides,
  };
}

function combineWithEmptyRuleset(classicPayload: unknown) {
  const rules = mapGitHubActiveBranchRules([], REPOSITORY, BRANCH, OBSERVED_AT);
  const classic = mapGitHubClassicBranchProtection(classicPayload, REPOSITORY, BRANCH, OBSERVED_AT);
  return combineBranchPolicyObservations([rules, classic], REPOSITORY, BRANCH, OBSERVED_AT);
}

test("classic mapper preserves explicit check app identity and explicit any-app semantics", () => {
  const observation = mapGitHubClassicBranchProtection(
    {
      required_status_checks: {
        strict: true,
        contexts: ["validate", "lint", "security"],
        checks: [
          { context: "validate", app_id: 15368 },
          { context: "lint", app_id: -1 },
          { context: "security", app_id: null },
        ],
      },
      required_pull_request_reviews: simpleReviews({ required_approving_review_count: 2 }),
      required_conversation_resolution: { enabled: false },
    },
    REPOSITORY,
    BRANCH,
    OBSERVED_AT,
  );

  assert.equal(observation.source, "GITHUB_CLASSIC_BRANCH_PROTECTION");
  assert.equal(observation.hasUnresolvedRequiredCheckSourceIdentity, false);
  assert.deepEqual(observation.requiredStatusChecks, [
    { context: "lint", integrationId: null },
    { context: "security", integrationId: null },
    { context: "validate", integrationId: 15368 },
  ]);
  assert.equal(observation.requiredApprovals, 2);
  assert.equal(observation.reviewFeatures.requireReviewThreadResolution, false);
});

test("legacy contexts without checks remain source-identity ambiguous", () => {
  const evidence = combineWithEmptyRuleset({
    required_status_checks: {
      strict: true,
      contexts: ["validate"],
    },
    required_pull_request_reviews: simpleReviews(),
  });

  assert.equal(evidence.coverage, "COMPLETE");
  assert.equal(evidence.hasUnresolvedRequiredCheckSourceIdentity, true);
  assert.deepEqual(evidence.requiredStatusChecks, [{ context: "validate", integrationId: null }]);

  const derived = deriveProjectionPolicies(evidence);
  assert.equal(derived.ciPolicy, undefined);
  assert.equal(derived.reviewPolicy, undefined);
  assert.deepEqual(derived.blockedReasons, ["REQUIRED_CHECK_SOURCE_IDENTITY_UNKNOWN"]);
});

test("a check entry with omitted app_id also remains source-identity ambiguous", () => {
  const evidence = combineWithEmptyRuleset({
    required_status_checks: {
      checks: [{ context: "validate" }],
      contexts: ["validate"],
    },
    required_pull_request_reviews: simpleReviews(),
  });

  assert.equal(evidence.hasUnresolvedRequiredCheckSourceIdentity, true);
  assert.deepEqual(deriveProjectionPolicies(evidence).blockedReasons, ["REQUIRED_CHECK_SOURCE_IDENTITY_UNKNOWN"]);
});

test("contexts not represented by checks cannot silently inherit another check source", () => {
  const evidence = combineWithEmptyRuleset({
    required_status_checks: {
      checks: [{ context: "validate", app_id: -1 }],
      contexts: ["validate", "legacy-security"],
    },
    required_pull_request_reviews: simpleReviews(),
  });

  assert.equal(evidence.hasUnresolvedRequiredCheckSourceIdentity, true);
  assert.deepEqual(evidence.requiredStatusChecks, [
    { context: "legacy-security", integrationId: null },
    { context: "validate", integrationId: null },
  ]);
});

test("classic review and conversation requirements remain fail-closed when current projection cannot model them", () => {
  const evidence = combineWithEmptyRuleset({
    required_status_checks: null,
    required_pull_request_reviews: simpleReviews({
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
    }),
    required_conversation_resolution: { enabled: true },
  });

  const derived = deriveProjectionPolicies(evidence);
  assert.equal(derived.reviewPolicy, undefined);
  assert.deepEqual(derived.blockedReasons, [
    "DISMISS_STALE_REVIEWS_NOT_MODELED",
    "CODE_OWNER_REVIEW_NOT_MODELED",
    "LAST_PUSH_APPROVAL_NOT_MODELED",
    "REVIEW_THREAD_RESOLUTION_NOT_MODELED",
  ]);
});

test("simple complete classic evidence derives an any-App check policy", () => {
  const evidence = combineWithEmptyRuleset({
    required_status_checks: {
      checks: [{ context: "validate", app_id: -1 }],
      contexts: ["validate"],
    },
    required_pull_request_reviews: simpleReviews({ required_approving_review_count: 1 }),
    required_conversation_resolution: { enabled: false },
  });

  const derived = deriveProjectionPolicies(evidence);
  assert.deepEqual(derived.blockedReasons, []);
  assert.deepEqual(derived.ciPolicy, {
    requiredChecks: [{ context: "validate", integrationId: null }],
    requiredWorkflowNames: [],
  });
  assert.deepEqual(derived.reviewPolicy, { requiredApprovals: 1 });
});

test("complete classic evidence preserves an App-bound required check", () => {
  const evidence = combineWithEmptyRuleset({
    required_status_checks: {
      checks: [{ context: "validate", app_id: 15368 }],
      contexts: ["validate"],
    },
    required_pull_request_reviews: simpleReviews(),
    required_conversation_resolution: { enabled: false },
  });

  const derived = deriveProjectionPolicies(evidence);
  assert.deepEqual(derived.blockedReasons, []);
  assert.deepEqual(derived.ciPolicy, {
    requiredChecks: [{ context: "validate", integrationId: 15368 }],
    requiredWorkflowNames: [],
  });
});

test("classic mapper rejects conflicting or malformed consumed policy data", () => {
  assert.throws(
    () =>
      mapGitHubClassicBranchProtection(
        {
          required_status_checks: {
            checks: [
              { context: "validate", app_id: 1 },
              { context: "Validate", app_id: 2 },
            ],
          },
        },
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /Conflicting classic required status-check source/,
  );

  assert.throws(
    () =>
      mapGitHubClassicBranchProtection(
        { required_status_checks: { checks: [{ context: "validate", app_id: 0 }] } },
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /app_id must be null, -1, or a positive integer/,
  );

  assert.throws(
    () =>
      mapGitHubClassicBranchProtection(
        { required_pull_request_reviews: simpleReviews({ required_approving_review_count: 7 }) },
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /integer from 0 to 6/,
  );

  assert.throws(
    () =>
      mapGitHubClassicBranchProtection(
        { required_conversation_resolution: { enabled: "yes" } },
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /required_conversation_resolution.enabled must be a boolean/,
  );

  assert.throws(
    () =>
      mapGitHubClassicBranchProtection(
        { required_status_checks: { strict: true } },
        REPOSITORY,
        BRANCH,
        OBSERVED_AT,
      ),
    /must include checks or contexts/,
  );
});
