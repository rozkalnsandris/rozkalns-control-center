# Phase 2 commit-status evidence coverage

Issue: #40  
PR: #41  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration, source-only least-privilege correctness

## Purpose

Distinguish an authoritatively observed empty commit-status result from a commit-status source that was deliberately not requested because the dedicated GitHub App has not been granted `Commit statuses: read`.

Without that distinction, an empty array could falsely imply complete status evidence and allow a future provider to produce `PASS` from Check evidence alone even though GitHub may also have a same-named required commit status.

## Contract

`ChangeRequestReadSnapshot` carries both:

- `commitStatuses` — normalized exact-head commit-status evidence;
- `commitStatusCoverage` — either `OBSERVED` or `NOT_REQUESTED`.

### `OBSERVED`

The provider read was actually requested. An empty array therefore means the source was authoritatively observed and contained no statuses for the exact requested head.

This remains the default for existing `readAuthoritativePullRequestSnapshot()` callers so the new contract cannot silently weaken existing behavior.

### `NOT_REQUESTED`

The provider read is deliberately skipped. `commitStatuses` must be empty.

This state is intended for future least-privilege rollout stages where `statuses: read` has not been justified or granted. It is not equivalent to an authoritative empty result.

## CI fail-closed behavior

When a CI policy contains at least one required status-check context and commit-status coverage is `NOT_REQUESTED`, every such context receives waiting evidence in addition to the observed Check evidence.

Consequences:

- a successful Check alone cannot produce `PASS`;
- an observed failing Check remains `FAIL`;
- an observed in-progress Check remains `RUNNING`;
- a workflow-only policy may still pass because commit statuses are irrelevant when there are no required status-check contexts.

This preserves the existing evidence precedence: failure first, then running, then waiting, then success.

## Snapshot integrity

Projection rejects contradictory snapshots where:

- `commitStatusCoverage=NOT_REQUESTED`; and
- `commitStatuses` is non-empty.

Exact-head validation remains mandatory for every commit status that is present.

## Why this precedes the concrete provider

The merged rollout plan keeps `statuses: read` conditional on explicit repository evidence. A concrete provider must therefore be able to omit that endpoint without pretending the source was observed.

This source contract establishes that distinction before any live GitHub App permission or Worker integration exists.

## Official GitHub semantics rechecked 2026-08-11

Current GitHub documentation states that required status checks may be provided by Checks or commit statuses. If a Check and a commit status have the same required name, both must pass. The exact-head commit-status REST endpoint is separately permissioned for GitHub Apps, and GitHub recommends requesting only the minimum permissions required by the App.

Those external semantics must be rechecked again at the future live permission-canary step.

## Validation

Issue #40 regression coverage proves:

- default authoritative snapshot behavior reads commit statuses and records `OBSERVED`;
- explicit `NOT_REQUESTED` skips the provider method and returns an empty status array;
- a successful required Check cannot become CI `PASS` while commit-status coverage is unrequested;
- Check failure/running evidence retains `FAIL`/`RUNNING` precedence;
- workflow-only CI can still pass;
- contradictory snapshots fail before projection;
- source-boundary tests keep the new model free of GitHub HTTP/auth, Worker wiring and Cloudflare runtime bindings.

Initial CI #104 failed closed only because an existing projection test fixture did not yet declare the new required coverage field. The fixture was corrected to explicitly default to `OBSERVED`; production types were not weakened. Source/test CI #105 then passed policy, runtime audit, typecheck, typed lint, all unit tests, Worker/SPA build and Wrangler dry-run.

## Non-goals / unchanged gates

This task does not:

- create the concrete GitHub provider adapter;
- create/install/configure the real `Rozkalns Control` GitHub App;
- grant `statuses: read` or any other permission;
- perform a live GitHub canary;
- add secrets, credentials or private keys;
- wire GitHub into the Worker;
- add Cloudflare D1/Queue/DLQ/runtime bindings;
- deploy Cloudflare;
- mutate RPi5, production DB or host state;
- add any GitHub write capability.

`RPi5_main#140` remains independently gated at `WAIT_FOR_GENUINE_NEWER_AUTO_DEPLOY_SAFE_DELTA`.

## Deploy impact

`DEPLOY_REQUIRED=no`.
