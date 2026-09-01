# Delivery Roadmap

This roadmap mirrors master issue #1 at phase level so implementation workers can determine the current product gate without depending on chat history. If this file and master issue #1 differ, master issue #1 wins until this document is reconciled.

Detailed implementation chronology remains available in Git history and the linked GitHub issues/PRs. `docs/ROADMAP_CURRENT_CHECKPOINT.md` is the concise current evidence checkpoint.

Last reconciled: **2026-09-01**.

## Evidence model

Current source baseline for this reconciliation:

- `main=842041e926c7a6662b4979a1e0463be48837a018`;
- CI #687 / run `33476822724`: **SUCCESS**;
- FAST-LANE policy drift #115 / run `33476823050`: **SUCCESS**;
- GITHUB-ONLY policy drift #103 / run `33476823074`: **SUCCESS**.

Repository source proves intended code/config/policy/validation/release behavior. It does **not** by itself prove the current production Worker deployment, bindings, secrets, routes, D1/Queue state, GitHub App permissions, host state or live authorization. Runtime/live claims require separate canonical execution evidence and fresh preflight at the relevant gate.

## Phase 0 — repository + contracts

Goal: create a safe, understandable codebase before any live integration.

**Status: COMPLETE.**

Core evidence includes the repository contracts, architecture/threat-model baseline, deterministic state model, React/TypeScript/Worker skeleton, CI and repository safety checks.

Permanent boundary: Phase 0 completion authorizes no production integration or privileged mutation.

## Phase 1 — mobile-first read-only UI

Goal: prove the Android-first decision UX before live GitHub writes.

**Status: COMPLETE.**

Implemented contracts include:

- project overview and `Needs Andris` priority queue;
- deterministic decision/read models;
- Working/Waiting/Failed/Merge-ready presentation;
- responsive compact-phone layout and >=48px primary touch targets;
- visible focus and non-color-only status meaning;
- fixture-mode safety so mocked actions cannot be mistaken for live mutations.

Phase 1 completion does not grant GitHub write authority.

## Phase 2 — live read-only GitHub/control-plane foundation

Goal: replace fixtures with trustworthy, fail-closed live GitHub state and durable reconciliation.

**Status: SOURCE + HISTORICAL LIVE-READ FOUNDATION ESTABLISHED; no current production snapshot is re-certified by this docs reconciliation.**

The current repository contains the mature read/control-plane foundation that Phase 3 depends on:

- managed-repository policy and provider-neutral read interfaces;
- bounded GitHub REST GET transport and fixed GraphQL merge-state query;
- GitHub App JWT/installation session boundaries;
- exact-head Checks/workflows/reviews/status evidence and latest-effective rerun selection;
- branch-policy provenance and fail-closed incomplete-policy handling;
- authoritative reconciliation/projection;
- Access-protected dashboard/reconciliation routes;
- webhook HMAC, delivery idempotency and Queue/D1 reconciliation contracts/runtime;
- production D1/Queue source configuration and read-only operational preflight tooling.

Phase 2 source/read completion is sufficient for current Phase 3 source implementation. It does not convert historical production facts into a fresh runtime guarantee. Before any production-dependent action, re-read the exact current runtime state with GET-only evidence.

### Phase 2 permanent safety rules

- observational/read paths do not imply GitHub write permission;
- unknown, stale, partial or identity-mismatched evidence fails closed;
- merge authority is distinct from production deploy authority;
- no RPi5/root mutation is implied by Control Center source state;
- no AI coding/runtime authority is implied.

## Phase 3 — authenticated human decision actions

Goal: make `Needs Andris` perform real, auditable GitHub decisions while preserving exact-head, policy and owner gates.

**Status: ACTIVE / SUBSTANTIALLY SOURCE-IMPLEMENTED.**

Current `main` contains all three primary action families. Their live readiness is intentionally independent.

### Merge

**Source status: implemented and wired. Historical bounded canary lifecycle: COMPLETE / PASS. Standing live authority: NONE.**

Current source includes:

- exact-head authoritative decision and stale-state rejection;
- explicit `merge`/`squash`/`rebase` method binding;
- least-privilege installation write session and exact-head Merge writer;
- D1 `merge_decisions` audit/idempotency store with migration `0008`;
- Access-authenticated `/api/github/merge` Worker route/runtime;
- typed React action caller with explicit second confirmation;
- GET-only/read-only preflight/access-classification tooling;
- one-shot canary and post-canary reconciliation workflow source/tests.

Canonical #278 continuity records the reviewed one-shot Merge canary as completed successfully: disposable `ops-workflows` PR #24 was merged, paired issue #25 closed, and post-canary reconciliation run `33383001360` passed with GitHub evidence plus D1 SELECT-only audit. Those authorizations are consumed/non-replayable.

Every future real Merge still requires fresh exact-target evidence and separate owner MERGE authorization. Merge never authorizes deploy, DB/Queue writes, permission growth, Cloudflare mutation, secrets or host mutation.

### Needs changes

**Source status: implemented and Worker-wired. Live permission/capability/canary state: separately gated.**

Current source includes:

- guarded GitHub `REQUEST_CHANGES` writer bound to exact `commit_id`;
- authoritative fresh revalidation and deterministic audit/idempotency behavior;
- D1 audit implementation with migration `0002`;
- least-privilege installation review session;
- Access-authenticated `/api/github/needs-changes` route/runtime plus GET-only preflight route;
- project capability gating and bounded failure mapping;
- typed React caller with explicit confirmation and bounded message.

Older phase documents that call this path “detached” are historical. Current `src/worker/index.ts` is the source-level wiring truth. Production GitHub App write permission, capability activation, exact deployed Worker state and any live canary must still be freshly proven and separately authorized.

### Later

**Source status: implemented and Worker-wired. Live activation: separately gated.**

Current source includes:

- deterministic material-state fingerprinting;
- D1 deferral store and migration `0009`;
- Access-authenticated `/api/github/later` route/runtime;
- selected source canary capability policy;
- typed React caller with explicit confirmation;
- read-only preflight and bounded one-shot-canary workflow source/tests.

`Later` is only a deferral. It grants no Merge, review, deploy, DB, permission or host authority.

### Phase 3 exit gate

Phase 3 is complete only when the supported actions have the intended production capability/permission/runtime state, bounded live evidence where required, deterministic audit/replay behavior, stale authorization rejection, and a phone decision flow that cannot bypass CI/review/project policy.

A successful canary for one action does not implicitly activate the other actions or create standing authorization.

## Phase 4 — notifications + deterministic continuation

Goal: reduce normal interaction to meaningful gates and continue deterministically without relying on old chat memory.

**Status: SUBSTANTIAL SOURCE IMPLEMENTATION; notification transport and continuation activation remain gated/dormant.**

### Notification source state

Current source includes:

- notification transitions;
- delivery-intent, delivery-attempt and dispatch-claim persistence/migrations (`0003`–`0006`);
- D1 transition/delivery/dispatch stores;
- deterministic retry/claim/transition contracts;
- Queue-runtime notification composition;
- decision deep-link source support;
- focused source/runtime regression tests.

The current source boundary deliberately keeps notification activation dormant unless exact opt-in bindings are present. Current `wrangler.jsonc` does not set the notification transition/target bindings. Source tests also prove no Telegram API, Web Push/VAPID transport or corresponding secret is wired into this slice.

Therefore notification persistence/orchestration source is **not** evidence that end-user notifications are live.

### Deterministic continuation source state

Current source includes:

- continuation campaign persistence (`0007`);
- continuation planner/coordinator;
- authoritative recovery;
- current-ready persistence;
- deterministic next-task reservation;
- post-merge transition and reselection;
- D1 continuation readers/stores;
- Cloudflare continuation runtime composition and focused tests.

The continuation runtime remains source-only/dormant by default: `CONTROL_CONTINUATION_RUNTIME_ENABLED` is not set in current `wrangler.jsonc`, and the Worker does not currently invoke continuation methods from a route, queue handler or scheduler.

### Remaining Phase 4 work

- choose and implement the intended real notification transport (Telegram and/or web push) under its own secret/trust-boundary review;
- activate notification runtime only through a reviewed production gate;
- decide the exact continuation trigger/bridge and prove unattended capabilities rather than assuming them;
- retain pause/noise-control and deterministic campaign semantics;
- prove one end-to-end workflow can reach `Needs Andris`, notify once, accept/record a decision, and advance to a deterministic next state.

## Phase 5 — production visibility

Goal: show production truth without weakening the existing production control plane.

**Status: EARLY SOURCE MARKERS / GET-ONLY PREFLIGHT TOOLING; full product adapter not yet evidenced.**

Current source includes read-only production-baseline tooling such as `.github/workflows/daily-mvp-production-preflight.yml`. That workflow can GET GitHub/Cloudflare evidence for exact-main CI, active Worker deployment/version, traffic, selected bindings and custom-domain identity while explicitly denying deploy authorization.

That is useful operational evidence but is not yet the full Phase 5 product surface.

### Remaining Phase 5 deliverables

- sanitized read-only RPi5/production-control-plane adapter;
- normalized GitHub main SHA vs production SHA evidence;
- deploy-class projection;
- runtime/health/rollback evidence projection;
- drift/blocker display in the Control UI;
- explicit provenance/freshness so production readiness cannot be inferred from repository source alone.

### Phase 5 permanent boundaries

- no direct SSH/sudo/root mutation from Control Center;
- no production DB writes from visibility reads;
- no bypass of the existing RPi5/production controller/helper gates;
- any deploy/cutover/rollback remains separately owner-authorized and fail-closed.

## Final optional phase — AI/agent runtime

Only after the approval/control product is proven valuable and its trust boundaries are explicitly designed.

No current roadmap/source milestone grants AI execution authority.

## Current execution note

Issue #497 is the active AUTO-RUN FULL source-only reconciliation queue for the current run. It explicitly excludes P9/P10 and grants no standing merge or live authority. Source PRs produced by that queue stop at the owner MERGE gate. Production/live mutations always require a separate fresh authorization.