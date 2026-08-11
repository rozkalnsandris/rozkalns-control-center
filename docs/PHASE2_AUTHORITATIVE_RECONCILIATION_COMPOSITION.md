# Phase 2 authoritative reconciliation composition

## Purpose

Issue #47 / PR #48 adds the source-only composition boundary between authoritative GitHub reads, branch-policy evidence and the existing `DecisionReadModel` projection.

The composition prevents a future runtime handler from inventing its own sequencing. It does not add a live GitHub connection, permission, credential, Worker route or mutation.

## Inputs

`reconcileAuthoritativePullRequestDecision()` accepts:

- one provider-neutral `SourceControlReadProvider`;
- one narrow `BranchPolicyEvidenceReader`;
- managed repository identity;
- exact issue and pull-request numbers;
- one explicit reconciliation observation time;
- optional commit-status coverage (`OBSERVED` or `NOT_REQUESTED`);
- optional trusted deploy impact, defaulting to `UNKNOWN`.

The composition owns no HTTP, auth, credential or platform binding.

## Read order and identity

The composition:

1. validates the managed repository, positive issue/PR numbers and observation time;
2. reads the authoritative pull-request snapshot through the existing exact-head snapshot reader while reading open issues from the same provider instance;
3. requires the requested issue to exist exactly once in the open-issue read;
4. asks the injected branch-policy reader for policy evidence for the snapshot's observed default branch and the same observation time;
5. rejects repository, branch or observation-time mismatches;
6. derives CI/review policy only through `deriveProjectionPolicies()`;
7. projects through `projectAuthoritativeSnapshotToDecision()` only when policy evidence is complete and representable.

Exact-head checks for merge state, Check Runs, commit statuses and workflow runs remain owned by the existing authoritative snapshot/projection gates.

## Result contract

The result is a discriminated union.

### `BLOCKED`

Returned when branch-policy evidence cannot safely produce CI/review policy. The result contains only sanitized identity/evidence needed to explain the block:

- repository, issue and PR number;
- observation time;
- default branch, main SHA and PR head SHA;
- commit-status coverage;
- policy coverage/source provenance;
- sanitized blocked-reason codes.

A blocked result contains **no `DecisionReadModel`**.

Examples include:

- `UNKNOWN` or `PARTIAL` branch-policy coverage;
- unresolved required-check producer identity;
- code-owner, stale-review, last-push, review-thread or file-pattern semantics not yet modeled;
- an unexpected case where projection policy is unavailable.

The currently merged Metadata-only active-rules reader intentionally produces `PARTIAL` evidence until classic branch-protection evidence is separately authorized and observed. Therefore the current source-only path remains blocked rather than fabricating merge readiness.

### `PROJECTED`

Returned only when branch-policy evidence is `COMPLETE`, repository/branch/time identity matches, and `deriveProjectionPolicies()` returns representable CI and review policy.

The existing projection remains authoritative for CI/review/merge-state behavior and still exposes only `OPEN_PR`; this task does not add a Merge mutation.

## Commit-status coverage

The composition passes commit-status coverage unchanged into the existing authoritative snapshot reader.

- `OBSERVED`: commit statuses are actually read.
- `NOT_REQUESTED`: the status source is skipped.

For a required status-check context, `NOT_REQUESTED` cannot become implicit empty-success evidence. Even with a successful Check Run, the existing projection remains `WAITING` until the status source is actually observed or policy proves it unnecessary.

## Failure behavior

The composition fails closed for:

- unmanaged repository;
- invalid issue/PR number or observation time;
- requested issue absent from the open-issue read;
- inconsistent/duplicate issue evidence;
- policy repository mismatch;
- policy branch mismatch;
- policy observation-time mismatch;
- malformed runtime policy coverage;
- existing stale/exact-head snapshot failures.

Errors are sanitized and do not include credentials or raw platform responses.

## Source-only boundary

This task introduces none of the following:

- GitHub HTTP/fetch implementation;
- `Authorization`/Bearer handling;
- GitHub App token/JWT/private-key handling;
- new GitHub permission stages;
- classic branch-protection reader or `Administration: read`;
- Worker route or UI live-data wiring;
- Cloudflare Access/D1/Queue/DLQ bindings;
- RPi5 access or mutation;
- GitHub write capability;
- AI execution.

The source-boundary regression also keeps `src/worker/index.ts` disconnected from this composition.

## Current sequencing

PR #46 merged the Metadata-only active branch-rules reader as `450016bf609ca8f30fbe962e9df26b5b058db965`. The current RPi5 #140 state is independent: the current CV production→main range remains `NO_DEPLOY`, so no AUTO execution canary is authorized.

A real Control GitHub App, live permission canaries, signer/secret binding, Worker reconciliation wiring and any Cloudflare deployment remain separate owner-gated steps.

## Deploy impact

`DEPLOY_REQUIRED=no`.
