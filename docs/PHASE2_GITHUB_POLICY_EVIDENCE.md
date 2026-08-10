# Phase 2 GitHub Branch-Policy Evidence Contract

Issues: #15, #17

This document defines how Rozkalns Control may reason about required CI and pull-request review policy before any live GitHub mutation exists.

## Why this layer exists

The existing Phase 2 projection intentionally refuses to invent CI/review `PASS` without explicit policy. GitHub policy can come from more than one mechanism:

- repository/organization **rulesets**;
- classic **branch protection**.

Those mechanisms can coexist. Reading one mechanism and assuming it is the entire merge policy would create a false-ready risk.

Therefore Control models policy as evidence with explicit provenance and coverage rather than as an unqualified list of required checks/reviews.

## Current official GitHub basis — rechecked 2026-08-10

### Active rules for a branch

GitHub documents:

`GET /repos/{owner}/{repo}/rules/branches/{branch}`

The endpoint returns active rules applying to the branch, including repository- and organization-level rulesets. Rulesets in `evaluate` or `disabled` mode are not included.

For a GitHub App installation token, the documented minimum permission is:

- Repository **Metadata: read**.

The rules payload can include, among other rules:

- `required_status_checks` with required check `context` and optional `integration_id`;
- `pull_request` with `required_approving_review_count`;
- code-owner review requirements;
- last-push approval requirements;
- review-thread resolution requirements;
- required file-pattern reviewers.

### Classic branch protection

GitHub documents:

`GET /repos/{owner}/{repo}/branches/{branch}/protection`

For a GitHub App installation token, the documented minimum permission is:

- Repository **Administration: read**.

The response can expose:

- `required_status_checks.contexts`;
- the more precise `required_status_checks.checks[]` with `context` and `app_id`;
- `required_pull_request_reviews.required_approving_review_count`;
- stale-review dismissal;
- required code-owner review;
- last-push approval;
- `required_conversation_resolution.enabled`.

GitHub documents `app_id=-1` as explicitly allowing any App to provide that required check. A positive `app_id` binds the check to that GitHub App. A `checks[]` item with a missing `app_id`, or a legacy `contexts` entry that has no corresponding `checks[]` item, does not provide enough producer identity for Control to safely flatten the requirement to a name-only check.

This source-only phase parses those fields but does **not** add `Administration: read` or make a live branch-protection request.

## Provenance model

A branch-policy observation identifies exactly one authoritative source read:

- `GITHUB_ACTIVE_RULES`;
- `GITHUB_CLASSIC_BRANCH_PROTECTION`.

A successful read that returns no requirements still counts as an observation. This matters because "observed and absent" is different from "never checked".

Coverage is derived from the observed source set:

- `UNKNOWN` — neither source observed;
- `PARTIAL` — only one source observed;
- `COMPLETE` — both currently modeled policy sources observed.

Ruleset evidence alone is deliberately `PARTIAL` while classic branch protection is unverified.

## Conservative combination rules

When multiple observations are combined for the same repository/branch/reconciliation time:

- required status-check contexts are unioned;
- required approval count uses the strictest observed count (`max`);
- review-complexity flags use logical OR;
- unresolved required-check producer identity is propagated with logical OR;
- duplicate observations for the same source are rejected;
- repository/branch mismatches are rejected;
- mixed reconciliation timestamps are rejected;
- conflicting explicit source identities for the same required status-check context are rejected.

## Required check source identity

GitHub rulesets may bind a required status check to a specific integration using `integration_id`. Classic branch protection can bind a required check using `checks[].app_id`.

The current `CheckRunRead` model evaluates checks by name and does not yet preserve/verify the originating GitHub App identity. Reducing a producer-bound check to only its name could accept a same-named check from the wrong producer.

Therefore:

- any required check with a non-null explicit integration/App ID blocks current CI policy derivation with `REQUIRED_CHECK_SOURCE_IDENTITY_NOT_MODELED`;
- any required check whose source identity could not be resolved from the policy payload blocks derivation with `REQUIRED_CHECK_SOURCE_IDENTITY_UNKNOWN`.

Legacy classic `contexts` are particularly important here. They are still preserved as required names, but they are marked unresolved unless a corresponding `checks[]` entry provides explicit producer semantics.

This is fail-closed by design.

## Complex review requirements

The current `ReviewRequirementPolicy` contains only `requiredApprovals: number`.

That simple model cannot fully encode:

- dismiss-stale-reviews-on-push semantics;
- required code-owner review;
- approval of the most recent reviewable push;
- required review-thread/conversation resolution;
- required file-pattern/team reviewers.

If any of those semantics are active, policy derivation is blocked rather than flattening them into an unsafe approval count.

## Projection contract

`deriveProjectionPolicies()` may return the existing `CiRequirementPolicy` and `ReviewRequirementPolicy` only when:

1. branch-policy coverage is `COMPLETE`;
2. required-check producer identity is known;
3. required checks do not require an unmodeled integration identity;
4. review policy contains no unmodeled complex semantics.

Otherwise the function returns only explicit `blockedReasons` and no policy objects. The existing projection then remains `WAITING/PENDING`.

Even complete policy evidence does not create a Merge action. Phase 2 remains read-only and still requires the exact-head authoritative GitHub merge-state gate introduced by issue #12 / PR #14.

## Live rollout implication

The future dedicated `Rozkalns Control` GitHub App should first canary the Metadata-read active-rules endpoint on selected repositories. A later, separately authorized canary may test classic branch-protection reads only if `Administration: read` is explicitly approved after permission/threat review.

The source-only classic mapper added by issue #17 exists so that any future permission decision can be evaluated against deterministic tests before credentials or live transport are introduced. It does not itself justify the permission expansion.

No App installation, permission change, token, network client, Cloudflare binding, RPi5 mutation or GitHub write is introduced by issues #15/#17.

`DEPLOY_REQUIRED=no`.
