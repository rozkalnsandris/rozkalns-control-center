# Phase 2 GitHub Branch-Policy Evidence Contract

Issues: #15, #17, #19

This document defines how Rozkalns Control may reason about required CI and pull-request review policy before any live GitHub mutation exists.

## Why this layer exists

The Phase 2 projection intentionally refuses to invent CI/review `PASS` without explicit policy. GitHub policy can come from more than one mechanism:

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

GitHub documents `app_id=-1` as explicitly allowing any App to provide that required check. A positive `app_id` binds the check to that GitHub App. A `checks[]` item with a missing `app_id`, or a legacy `contexts` entry that has no corresponding `checks[]` item, does not provide enough producer identity for Control to trust an App-binding claim.

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

- required status-check contexts are unioned case-insensitively;
- explicit required-check integration/App identity is preserved;
- conflicting explicit source identities for the same required context are rejected;
- required approval count uses the strictest observed count (`max`);
- review-complexity flags use logical OR;
- unresolved required-check producer identity is propagated with logical OR;
- duplicate observations for the same source are rejected;
- repository/branch mismatches are rejected;
- mixed reconciliation timestamps are rejected.

## Required status evidence

GitHub required-status policy and runtime evidence are separate concepts:

- policy says which context is required and, where applicable, which GitHub App must produce it;
- runtime evidence can be a Check Run or a commit status on the exact PR head SHA.

Issue #19 extends the evidence model so a `CiRequirementPolicy` carries:

- required context;
- expected integration/App ID, or `null` for any producer;
- any separately required workflow names.

### Check Run evidence

`CheckRunRead` preserves the originating `check_run.app.id` when GitHub supplies it.

For GitHub required-status semantics, a completed Check Run is passing when its conclusion is:

- `success`;
- `neutral`;
- `skipped`.

Explicit failure conclusions remain failures. Non-final or ambiguous conclusions remain running/waiting rather than being treated as success.

If policy binds a required context to a specific App ID, only a same-context Check Run from that App may satisfy the requirement. A same-named Check from another or unknown App remains non-passing.

### Commit-status evidence

Legacy commit statuses are modeled separately and bound to the exact PR head SHA.

The status endpoint is treated as newest-first. Only the first/latest effective status per case-insensitive context is retained. States are:

- `success`;
- `failure`;
- `error`;
- `pending`.

A commit status does not prove a Check Run GitHub App identity. Therefore a commit status cannot independently satisfy an App-bound required check. If same-context Check and status evidence both exist, Control evaluates the combined evidence conservatively so an explicitly failing source is not silently discarded.

## Unknown producer identity

Policy payloads can still be ambiguous. Legacy classic `contexts` entries without a corresponding explicit `checks[].app_id`, or malformed/missing producer identity where the policy source cannot establish semantics, set `hasUnresolvedRequiredCheckSourceIdentity=true`.

That blocks policy derivation with:

`REQUIRED_CHECK_SOURCE_IDENTITY_UNKNOWN`

This remains fail-closed by design.

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

`deriveProjectionPolicies()` may return `CiRequirementPolicy` and `ReviewRequirementPolicy` only when:

1. branch-policy coverage is `COMPLETE`;
2. required-check producer semantics are known;
3. review policy contains no unmodeled complex semantics.

An explicit App-bound required check is now representable because its App ID is carried into the CI policy and verified against runtime Check evidence. Unknown producer semantics remain blocked.

Even complete policy evidence does not create a Merge action. Phase 2 remains read-only and still requires the exact-head authoritative GitHub `MERGEABLE/CLEAN` gate introduced by issue #12 / PR #14.

## Live rollout implication

The future dedicated `Rozkalns Control` GitHub App should first canary the Metadata-read active-rules endpoint on selected repositories. Commit-status reads, if required by actual managed repository policy/evidence, require a separately verified Repository **Commit statuses: read** permission. A later classic branch-protection canary may be considered only if `Administration: read` is explicitly approved after permission/threat review.

None of issues #15/#17/#19 creates a live GitHub client, installs an App, changes permissions, creates Cloudflare bindings, mutates RPi5 or enables GitHub writes.

`DEPLOY_REQUIRED=no`.
