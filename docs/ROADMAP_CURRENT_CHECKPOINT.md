# Rozkalns Control — Current Roadmap Checkpoint

Last reconciled: **2026-09-01**.

Master issue #1 remains the canonical product/architecture contract. `docs/ROADMAP.md` is the long-form roadmap. This checkpoint records the current source baseline and the strongest separately evidenced runtime facts without treating repository source as proof of production deployment.

## Evidence boundary

- Canonical source baseline: `main=842041e926c7a6662b4979a1e0463be48837a018`.
- Exact-main CI: run `33476822724` / CI #687 — **SUCCESS**.
- Exact-main FAST-LANE policy drift: run `33476823050` / #115 — **SUCCESS**.
- Exact-main GITHUB-ONLY policy drift: run `33476823074` / #103 — **SUCCESS**.
- Source/config/docs on `main` prove intended implementation only. They do **not** by themselves prove the current production Worker version, bindings, secrets, D1/Queue state, GitHub App permissions, Cloudflare routes, live authorization state, or host/runtime state.
- Live/runtime claims below are made only where canonical continuity records an executed and reconciled gate. Any future live action still requires fresh GET-only preflight and its own explicit owner authorization.

## Current phase classification

- Phase 0 — repository/contracts: **COMPLETE**.
- Phase 1 — mobile-first decision UI: **COMPLETE**.
- Phase 2 — read-only GitHub/control-plane foundation: **SOURCE + historical live-read foundation established; not re-certified here as a current production snapshot**.
- Phase 3 — authenticated human decision actions: **ACTIVE / SUBSTANTIALLY SOURCE-IMPLEMENTED**. Merge, Needs changes and Later all exist in current source; their production/live readiness differs and remains independently gated.
- Phase 4 — notifications + deterministic continuation: **SUBSTANTIAL SOURCE IMPLEMENTATION; runtime activation/transport still gated**.
- Phase 5 — production visibility: **EARLY SOURCE MARKERS / GET-only preflight tooling; full production-visibility adapter not yet evidenced**.

## Phase 3 — authenticated human decision actions

### Merge

Current source contains the guarded Merge stack:

- exact-head decision model and authoritative revalidation;
- D1 `merge_decisions` audit/idempotency store and migration `0008_merge_decision_audit.sql`;
- one-repository installation write session and exact-head Merge writer;
- Access-authenticated `/api/github/merge` route/runtime registered in `src/worker/index.ts`;
- typed React caller with second confirmation and exact decision evidence binding;
- read-only preflight, access-classification, one-shot canary and post-canary reconciliation workflows/tests.

Canonical #278 continuity records the bounded Phase 3 Merge canary lifecycle as **COMPLETE / PASS**: the reviewed one-shot backend canary merged the disposable `ops-workflows` PR #24, paired issue #25 was closed/completed, and post-canary reconciliation run `33383001360` completed successfully with GitHub evidence plus D1 SELECT-only audit. Those historical authorizations are consumed/non-replayable and do not authorize another Merge.

Current source readiness is therefore materially beyond “not started”. Every future real Merge remains separately owner-authorized and freshly revalidated; source presence or the historical canary does not grant standing live authority.

### Needs changes

Current source contains:

- guarded `REQUEST_CHANGES` decision/write contract;
- exact `commit_id` binding and authoritative fresh revalidation;
- D1 audit/idempotency implementation plus `0002_needs_changes_audit.sql`;
- installation review session;
- Access-authenticated `/api/github/needs-changes` route/runtime and GET-only preflight route registered in the Worker entrypoint;
- project capability gating and failure mapping;
- typed UI decision-action caller.

Older phase documentation still describes this path as detached, but current `src/worker/index.ts` is stronger evidence for present source wiring. This checkpoint does **not** claim that the required production GitHub App write permission, exact project capability, Worker deployment or live canary is currently active. Those remain separate trust-boundary/live gates unless freshly proven otherwise.

### Later

Current source contains:

- deterministic Later material-state fingerprinting;
- D1 deferral persistence and migration `0009_later_deferrals.sql`;
- Access-authenticated `/api/github/later` route/runtime;
- source capability preparation for the selected canary repository;
- typed React caller with second confirmation;
- GET/read-only preflight and bounded one-shot-canary workflow source.

`Later` remains a deferral only; it grants no Merge, review, deploy, DB, permission or host authority. Production activation and any new live Later action remain separately gated.

## Phase 4 — notifications + deterministic continuation

The phase is no longer purely future in source.

### Notification source implemented

Current `main` includes:

- notification transition, delivery-intent, delivery-attempt and dispatch-claim migrations (`0003`–`0006`);
- D1 notification transition/delivery/dispatch stores;
- transition/delivery/retry/dispatch shared contracts;
- Queue-runtime composition and focused source-boundary/runtime tests;
- deterministic deep-link source support.

The notification runtime is deliberately dormant by default: source-boundary tests require the notification transition bindings to be absent from `wrangler.jsonc`, and current notification composition contains no Telegram API/Web Push/VAPID transport or corresponding secrets. Therefore “notification state/delivery intent source exists” must not be rewritten as “notifications are live”.

### Deterministic continuation source implemented

Current `main` includes:

- continuation campaign persistence (`0007_continuation_campaigns.sql`);
- deterministic continuation coordinator/planner;
- current-ready, next-task and post-merge transition/reselection logic;
- D1 continuation readers/stores;
- recovery coordinator and Cloudflare continuation runtime composition;
- focused tests for recovery, reservation, persistence and post-merge reselection.

`resolveContinuationRuntime()` remains a source-only composition point. `CONTROL_CONTINUATION_RUNTIME_ENABLED` is not set by current `wrangler.jsonc`, and the Worker has no route/queue/scheduler that invokes continuation methods in the current source slice. Activation remains a separate reviewed/live gate.

## Phase 5 — production visibility

Current source has useful read-only production evidence machinery, notably `.github/workflows/daily-mvp-production-preflight.yml`, which uses GET-only GitHub/Cloudflare reads to verify exact-main CI, active Worker deployment/version, 100% traffic, selected bindings and custom-domain identity while explicitly denying deploy authorization.

That workflow is an operational preflight marker, not the Phase 5 product adapter. Current source does not yet evidence the complete promised Phase 5 surface:

- sanitized RPi5 production adapter;
- normalized GitHub-main-vs-production-SHA projection;
- deploy-class projection;
- runtime/health/rollback evidence model in the Control UI;
- drift/blocker display backed by the production control plane.

Treat Phase 5 as **not complete** until those contracts exist and their runtime evidence is separately proven.

## Current safety boundary

This reconciliation changes documentation only. It does not authorize or perform:

- GitHub Merge/review/Later actions;
- production Worker deploy or Cloudflare mutation;
- D1/DB write or migration apply;
- Queue mutation;
- GitHub App permission/repository-selection change;
- secrets/credentials/tokens;
- repository settings/rulesets/branch protection;
- RPi5/root/systemd/Docker/network/host mutation;
- P9/P10 work.

For current execution continuity, issue #497 and controller #499 govern the active AUTO-RUN FULL source-only queue. Each source PR stops at its owner MERGE gate; merge never implies live/deploy authority.