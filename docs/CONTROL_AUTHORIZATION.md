# Unified Control authorization

Issue #84 defines a separate owner-authorization boundary for **future privileged adapter operations** across managed repositories. It is not the current Phase 3 human-decision path.

## Current role relative to Worker decision routes

Current source already contains dedicated Access-authenticated Worker routes for the bounded human decisions `Merge`, `Needs changes` and `Later`. Those routes use their own project capability, current-state, exact-head/material-state, authentication, idempotency and audit contracts.

This document does **not** replace, authorize or route those decisions through `workflow_dispatch`. A Merge / Needs changes / Later action must continue to satisfy its dedicated Worker-side contract and the current canonical owner/live gate. The existence of this unified authorization parser/registry creates no standing permission to invoke a Worker decision route.

The contract below remains an inert/fail-closed design for a separately introduced privileged adapter operation unless a focused source change and separate live authorization explicitly enable it.

## One privileged-adapter authorization shape

The source contract accepts one exact shape for its registered future adapter operation:

`authorize control <project-id> workflow_dispatch <exact-main-sha> ci <exact-ci-run-id>`

`project-id` is resolved only through `src/shared/project-policy.ts`. A comment cannot supply an arbitrary repository, workflow path, Cloudflare resource or host target.

The authorization records the exact target repository, expected 40-character lowercase `main` SHA and exact-main CI run ID. A future executor must re-resolve all of that live immediately before mutation; parsing an authorization is never sufficient proof by itself.

## Operation registry

The first registered operation remains `workflow_dispatch` because a future Control GitHub App write stage may use a short-lived installation token to dispatch a pre-reviewed workflow in a managed repository.

The registry deliberately records:

- required GitHub permission: `actions:write`;
- target selection: source-controlled allow-list;
- `liveEnabled: false`.

That disabled state is authoritative for this adapter contract. It must not be inferred enabled from completed Phase 3 decision canaries, Phase 4 notification work, a source merge, a GitHub App installation, or any historical authorization receipt.

This source contract does not grant `Actions: write`, mint a token, select a target workflow, dispatch a workflow, create a GitHub Environment/secret, invoke a current Worker decision endpoint or perform any production mutation.

## Adapter model

Control remains one operator/API surface while privileged execution stays separated by capability and trust boundary:

- GitHub Actions adapter — future dispatch only to a source-allow-listed workflow with an exact-repository, short-lived installation token;
- Cloudflare adapter — capability-scoped credentials/operations only when separately designed and authorized, never one broad super-token;
- RPi5 adapter — production authority remains governed by `RPi5_main`; Control must not create a direct SSH/root/generic-helper shortcut.

Unsupported project/operation combinations remain disabled until a focused source change and separate live owner authorization enable them.

Phase 5 production visibility is not a privileged adapter operation: its Control-side consumer accepts only already-sanitized read-only RPi5 evidence. Normalized production evidence never becomes authority to dispatch a workflow, deploy, mutate D1/application data, invoke rollback or cross the RPi5 trust boundary.

## Legacy first-D1 canary — retired

Issue #74 and migration `0001_reconciliation_core.sql` are completed and the one-shot authorization was consumed.

`.github/workflows/production-d1.yml` is an inert historical marker only:

- it no longer listens to `issue_comment` authorization events;
- it has no `production` Environment;
- it references no production secret;
- its only job is statically disabled with `if: false`.

The historical controller remains in source for evidence/local review, including replay defenses, but the GitHub Actions entry point cannot execute it. The consumed #74 authorization must never be reused.

Future privileged adapter execution must be introduced through a reviewed source-controlled target, exact-main SHA/CI revalidation, minimum separately authorized credential permission, explicit operation-specific authority and fail-closed/no-blind-retry handling.

Production deploy: NO.
Production mutation: NO.
GitHub permission expansion: NO.
Current Phase 3 decision-route authority: NO.
