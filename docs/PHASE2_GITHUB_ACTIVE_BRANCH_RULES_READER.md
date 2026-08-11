# Phase 2 GitHub active branch-rules reader

## Purpose

This document defines the source-only concrete reader for GitHub active branch rules introduced by issue #44 / PR #46.

It closes the implementation gap between the existing staged `metadata-rules` rollout manifest and the existing branch-policy mapper. It does **not** authorize a live GitHub App installation, permission change, credential binding, canary request or Cloudflare deployment.

## Exact source boundary

The reader accepts only:

- a validated `GitHubInstallationReadScope`;
- the existing bounded `GitHubInstallationReadTransport`;
- one explicit ISO observation time.

It constructs only this repository-scoped request:

```text
GET /repos/{owner}/{repo}/rules/branches/{encodedBranch}?per_page=100
required permission: metadata
```

The HTTP origin, authentication, credential lease validation, redirect policy, pagination boundary and request budget remain owned by the previously reviewed REST transport/session layers.

The reader itself has no `fetch()`, Authorization header, token, private key, JWT, mutation method or Worker binding.

## Current GitHub contract

GitHub documentation rechecked on 2026-08-12 states that `GET /repos/{owner}/{repo}/rules/branches/{branch}` returns the active rules that apply to a branch, including rules configured at higher levels, and GitHub App installation tokens require Repository **Metadata: read**. The endpoint supports pagination and `per_page` up to 100.

Classic branch protection is a different endpoint:

```text
GET /repos/{owner}/{repo}/branches/{branch}/protection
```

GitHub documents that classic endpoint as requiring Repository **Administration: read**. That permission and endpoint remain deliberately outside this reader and outside the staged source contract.

## Mapping and pagination

Every REST page for active rules must be an array. Pages are flattened in transport order and then passed once to the existing `mapGitHubActiveBranchRules()` mapper.

The mapper remains responsible for validating the consumed required-status-check and pull-request-review rule fields. Mapper failures are normalized to the reader's fixed `MALFORMED_RESPONSE` outcome so remote payload details are not copied into public errors.

Branch names are encoded as a single URL path segment. The original branch string is preserved in normalized policy evidence.

## Policy coverage remains partial

The helper `readGitHubActiveBranchPolicyEvidence()` combines only one observation source:

```text
GITHUB_ACTIVE_RULES
```

Therefore `combineBranchPolicyObservations()` returns:

```text
coverage = PARTIAL
```

until a separately authorized and successfully interpreted classic branch-protection observation exists.

This is intentional. `deriveProjectionPolicies()` must continue to return no CI/review policy and include:

```text
BRANCH_POLICY_COVERAGE_INCOMPLETE
```

Active-rules evidence alone can never fabricate complete branch-policy coverage or a green merge decision.

## Least privilege

This reader requires only `metadata: read` in its installation scope. If Metadata permission is absent, request construction fails before the REST transport executes.

This task does not add or imply:

- `administration: read`;
- `statuses: read`;
- any GitHub write permission;
- any classic branch-protection request;
- any live App installation or repository-selection change.

## Validation

Deterministic fake-transport regressions cover:

- exact endpoint path and `metadata` permission;
- one shared observation time;
- multi-page array flattening;
- required Check/App and review-count mapping through the existing mapper;
- slash-containing branch path-segment encoding;
- `PARTIAL` combined evidence and blocked policy derivation;
- missing Metadata permission before transport execution;
- invalid repository/time/branch input;
- malformed page shape and malformed consumed rule fields;
- source-boundary proof that classic/Admin/live runtime paths remain absent.

Source/test CI #116 passed policy checks, runtime audit, typecheck, typed lint, all unit tests, Worker + SPA build and Wrangler dry-run before this documentation reconciliation.

## RPi5 sequencing

`RPi5_main#140` remains independently gated. As re-read on 2026-08-12, current CV main is newer than the last proven production baseline, but the complete production-to-current-main range classifies `NO_DEPLOY`. It is therefore not an `AUTO_DEPLOY_SAFE` one-shot canary candidate, and no timer/legacy-runner authorization exists.

This source-only reader does not alter that boundary.

## Next live gate

After this source change is reviewed and merged, a **separate owner authorization** is still required before creating/installing the dedicated `Rozkalns Control` GitHub App or executing the Metadata permission stage against real repositories.

The first live policy canary should use the exact reviewed Metadata scope and this exact active-rules endpoint. Its real evidence should determine whether any later `Administration: read` classic-protection canary is justified; Administration must not be requested pre-emptively.

## Official references checked 2026-08-12

- GitHub REST API — Rules — **Get rules for a branch**.
- GitHub REST API — Protected branches — **Get branch protection**.
- GitHub Apps — choose minimum permissions / installation access-token scope guidance already recorded in the Phase 2 rollout/auth documents.
