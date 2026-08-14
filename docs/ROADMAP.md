# Delivery Roadmap

This repository-local roadmap records the current implementation sequence and phase gates for Rozkalns Control. Master issue #1 remains the canonical product/architecture contract; if a normative rule conflicts, master #1 wins until reconciled.

Last reconciled: **2026-08-14**.

## Current checkpoint

Rozkalns Control has moved beyond the original source-only Phase 2 foundation:

- Phase 0 repository/contracts: **COMPLETE**;
- Phase 1 mobile-first fixture UI: **COMPLETE**;
- public Cloudflare Worker + `control.rozkalns.net`: **LIVE**;
- accepted Samsung Galaxy A55 mobile-first polish: **LIVE**;
- dedicated `Rozkalns Control` GitHub App: **LIVE, READ-ONLY**;
- production D1 base migration: **APPLIED**;
- production live GitHub dashboard reads: **NOT ENABLED**;
- Phase 2 live-dashboard source boundary: **READY FOR REVIEW in PR #102**;
- Phase 3 GitHub write actions: **NOT STARTED / NOT AUTHORIZED**.

Current merged `main` before PR #102 is:

`b5cf46d53aee6cbbe235b6f639c934daba18dfc2`

Current PR #102 exact head is:

`a324f6e906cae97f6de473ccdd87744bec68376e`

Exact-head CI #199 / run `31827655423` is successful.

The immediate next owner gate is:

1. explicit `squash merge #102`;
2. verify the resulting exact `main` and exact-main CI;
3. only then design/authorize a separate production **LIVE READ-ONLY activation** gate;
4. keep all GitHub mutation actions unavailable until Phase 3.

---

## Phase 0 — repository + contracts

Goal: establish a safe, understandable repository before live integration.

**Status: COMPLETE.**

### Delivered

- [x] README + master-issue linkage;
- [x] `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`;
- [x] architecture, state model, threat model and ADR baseline;
- [x] issue/PR templates;
- [x] React + TypeScript + Vite + Cloudflare Worker skeleton;
- [x] authoritative CI covering dependency install, runtime audit, typecheck, lint, tests, build and Wrangler dry-run;
- [x] public-repository secret/action safety checks;
- [x] deterministic workflow: fresh branch → focused PR → exact-head CI → Ready → explicit owner merge.

### Permanent boundary

- no merge implies production deployment;
- no secrets in source/history;
- no RPi5/root mutation from ordinary source work;
- no AI API dependency required for the MVP.

---

## Phase 1 — mobile-first read-only UI

Goal: prove the Android-first decision UX before live GitHub writes.

**Status: COMPLETE and publicly deployed in fixture mode.**

### Delivered

- [x] deterministic project/decision fixture models;
- [x] `Needs Andris` priority queue;
- [x] `Working / Waiting`, `CI Failed`, `Merge Ready`, `Projects` hierarchy;
- [x] responsive 320–430 CSS px portrait contract;
- [x] Samsung Galaxy A55-class layout without device sniffing;
- [x] keyboard focus, skip navigation and text-based status meaning;
- [x] >=48px Android-oriented primary touch targets;
- [x] semantic native `<details>/<summary>` evidence disclosure;
- [x] explicit fixture safety so mock actions cannot mutate GitHub/Cloudflare/RPi5.

### 2026-08-14 mobile polish checkpoint

PR #98 was merged and deployed after real A55 screenshot review.

The production UI now has:

- [x] compact header with `FIXTURE MODE` retained in the header row;
- [x] reduced hero/vertical spacing;
- [x] combined Worker + fixture safety status strip;
- [x] collapsed evidence summary instead of always-visible SHA matrices;
- [x] primary full-width `Merge` presentation in fixture mode;
- [x] `Needs changes` + `Later` in a two-column row;
- [x] tertiary `Open PR` presentation;
- [x] compact lower-priority cards;
- [x] accepted A55 production screenshots with no obvious horizontal overflow.

Fixture UI remains a visual/read-model prototype only. No Phase 1 control performs a live GitHub write.

---

## Phase 2 — live read-only GitHub integration

Goal: replace fixture observations with trustworthy live GitHub state while keeping GitHub write capability absent.

**Status: CURRENT. Infrastructure/read-only trust boundaries are substantially live; normalized dashboard source is Ready in PR #102; production live-read flag remains disabled.**

### 2A — source-only foundation — COMPLETE

The reviewed source-only chain established:

- [x] six-repository managed-project allow-list and explicit excluded repository;
- [x] provider-neutral source-control read interface with no mutation methods;
- [x] exact-head PR/check/workflow evidence binding;
- [x] webhook HMAC/source contracts and durable delivery model;
- [x] normalized GitHub REST/GraphQL mappers;
- [x] fail-closed CI/review projection;
- [x] exact-head GitHub merge-state gate;
- [x] branch-policy provenance with `UNKNOWN` / `PARTIAL` / `COMPLETE` coverage;
- [x] classic branch-protection mapper without automatically requesting Administration permission;
- [x] commit-status/check producer identity modeling;
- [x] latest-effective Check/workflow rerun evidence selection;
- [x] D1 reconciliation schema and idempotency model;
- [x] type-aware Promise safety;
- [x] GitHub App installation-scope and short-lived credential lease contracts;
- [x] bounded repository-scoped REST GET transport;
- [x] GitHub App RS256 JWT + installation-token session boundary;
- [x] staged least-privilege rollout contract;
- [x] bounded fixed-query GraphQL merge-state transport;
- [x] conditional commit-status evidence coverage (`OBSERVED` vs `NOT_REQUESTED`);
- [x] concrete authoritative GitHub read provider;
- [x] Metadata-only active branch-rules reader;
- [x] fail-closed authoritative reconciliation composition.

Historical implementation evidence is retained in issues/PRs #8–#48 and focused Phase 2 docs rather than repeated line-by-line here.

### 2B — dedicated GitHub App rollout — COMPLETE for current read-only scope

Dedicated App:

`Rozkalns Control`

Known identities:

- App ID: `4567356`;
- Client ID: `Iv23likDoFtVeWBJfdFS`;
- installation ID: `153121564`.

Installed selected repositories exactly:

- [x] `rozkalnsandris/hermes-tech`;
- [x] `rozkalnsandris/hermes-deals`;
- [x] `rozkalnsandris/rozkalns-cv`;
- [x] `rozkalnsandris/RPi5_main`;
- [x] `rozkalnsandris/ops-workflows`;
- [x] `rozkalnsandris/rozkalnsandris`.

Explicitly excluded:

- [x] `rozkalnsandris/hermes-email-skill`.

Current granted repository permissions are read-only:

- [x] Metadata;
- [x] Contents;
- [x] Issues;
- [x] Pull requests;
- [x] Checks;
- [x] Actions.

Still deliberately absent:

- [ ] Commit statuses permission;
- [ ] Administration permission;
- [ ] GitHub write permissions.

Do not add `statuses: read` or `Administration: read` merely to make readiness appear greener. Evidence must justify any permission expansion and owner authorization remains mandatory.

### 2C — Cloudflare runtime + D1 bootstrap — COMPLETE for current fixture/read-only boundary

Production Cloudflare account:

`70e29dbca0e8363358659102d2b74178`

Worker:

`rozkalns-control`

Production D1:

- binding: `CONTROL_DB`;
- database: `rozkalns-control-production`;
- UUID: `8504e986-faf0-450c-bfb5-41b5dbf8be09`;
- jurisdiction: EU;
- source-controlled migrations directory: `migrations`.

Completed live gates:

- [x] production D1 migration `0001_reconciliation_core.sql` applied through a one-shot fail-closed gate;
- [x] GitHub App private-key secret binding exists as `GITHUB_APP_PRIVATE_KEY_PEM`;
- [x] Worker carries the non-secret App Client ID + installation ID bindings;
- [x] `CONTROL_LIVE_READ_ENABLED` exists and currently remains exactly `false`;
- [x] workers.dev disabled;
- [x] Preview URLs disabled.

Queue/DLQ/webhook runtime durability is **not** live yet.

### 2D — public UI rollout — COMPLETE in fixture mode

Public UI:

`https://control.rozkalns.net`

Current routing state:

- [x] custom domain attached;
- [x] workers.dev OFF;
- [x] Preview URLs OFF;
- [x] no route mutation performed by ordinary redeploys.

The first public rollout exposed an implementation bug in deployment-history verification: Cloudflare returns ordered deployment history, not a single deployment object. PR #96 corrected the verification contract to use the active/latest deployment while preserving exact one-version/100%-traffic checks.

PR #100 added an existing-domain redeploy gate so future Worker deploys can prove the existing `control.rozkalns.net` domain is unchanged rather than requiring `CUSTOM_DOMAIN=ABSENT`.

Latest proven production redeploy in this chat:

- Worker version: `ae86a000-845c-47e1-bac5-56a21d35fe07`;
- active deployment: `faca2dcd-354b-436b-bdb6-4c6a4a56d797`;
- traffic: `100%`;
- domain ID: `ac685929d45e825df5b5f6b803a9814b6dbf5d9d`;
- public routing change during redeploy: `NO_EXISTING_DOMAIN_PRESERVED`;
- public mode: `FIXTURE_ONLY`;
- live GitHub reconciliation: `DISABLED`.

All one-shot production authorizations used for the D1/UI/domain/redeploy gates are consumed and must never be reused.

### 2E — normalized live dashboard snapshot — READY FOR REVIEW

Issue #101 / PR #102 implements the missing UI-facing normalized live dashboard boundary.

Exact PR #102 head:

`a324f6e906cae97f6de473ccdd87744bec68376e`

Exact-head CI #199 / run `31827655423`: **SUCCESS**.

Delivered in PR #102:

- [x] one normalized dashboard snapshot over the existing GitHub App read runtime;
- [x] exactly the six managed repositories;
- [x] one canonical observation timestamp per snapshot;
- [x] real open issue counts;
- [x] real open PR counts;
- [x] real default-branch/main SHA;
- [x] PR identity/title/URL;
- [x] exact-head Checks;
- [x] exact-head workflow runs;
- [x] review observations;
- [x] GitHub merge-state observation;
- [x] `Cache-Control: no-store` Worker endpoint at `GET /api/github/dashboard`;
- [x] sanitized upstream failure responses;
- [x] request-scoped exact-repository installation-session reuse;
- [x] React single same-origin dashboard fetch;
- [x] `AbortController` cleanup/race protection;
- [x] explicit live/disabled/error UI states;
- [x] live `Open PR` rendered as a real semantic `<a>`;
- [x] A55/mobile layout preserved;
- [x] deterministic fake-provider/session tests; CI performs no live GitHub network request.

### 2F — fail-closed readiness rule — ACTIVE

The live observational dashboard must not fabricate human approval readiness.

Until branch-policy evidence is complete and representable:

- observed exact-head CI failure → `CI_FAILED`;
- latest effective `CHANGES_REQUESTED` → `NEEDS_ANDRIS`;
- draft/running/missing/ambiguous evidence → `WAITING`;
- observed CI pass plus GitHub `MERGEABLE/CLEAN` without complete policy evidence → still `WAITING`;
- observational live dashboard → **must not emit `MERGE_READY`**.

Commit statuses remain `NOT_REQUESTED` in the current live-dashboard scope.

### 2G — immediate next live gate

Do **not** enable live reads merely because PR #102 is Ready.

Required sequence:

- [ ] explicit owner `squash merge #102`;
- [ ] verify resulting exact `main`;
- [ ] verify exact-main push CI success;
- [ ] fresh production preflight against current Worker/domain/bindings;
- [ ] separately authorize the production live-read activation;
- [ ] change only the exact approved `CONTROL_LIVE_READ_ENABLED` runtime/config boundary;
- [ ] deploy through the existing-domain redeploy gate;
- [ ] verify `control.rozkalns.net` returns normalized live data for only six managed repositories;
- [ ] verify real `Open PR` links;
- [ ] verify no GitHub write capability/path appeared;
- [ ] keep incomplete branch-policy evidence fail-closed;
- [ ] record exact version/deployment/domain evidence and consume the authorization.

Until that gate completes, production remains **fixture-only**.

### Remaining Phase 2 durability/integration work

These are not prerequisites for merging #102 but remain before the full event-driven Phase 2 exit gate:

- [ ] authenticated live GitHub webhook activation/event subscriptions;
- [ ] webhook secret binding;
- [ ] Queue binding;
- [ ] DLQ binding;
- [ ] producer/consumer runtime handlers;
- [ ] bounded retry exhaustion and observable DLQ state;
- [ ] atomic durable delivery transitions in production;
- [ ] UI projection of reconciliation/DLQ failures;
- [ ] determine whether any managed repository genuinely requires legacy Commit statuses;
- [ ] determine whether complete policy coverage truly requires a separately authorized Administration/classic-protection canary.

### Phase 2 must not do

- no GitHub source writes;
- no live Merge mutation;
- no review/comment/rerun mutation;
- no RPi5/root mutation;
- no deployment implied by source merge;
- no AI execution;
- no permission expansion for convenience.

### Phase 2 exit gate

Phase 2 is complete only when:

- live dashboard state deterministically matches GitHub for the managed repositories;
- stale/unknown/partial evidence fails closed;
- invalid/replayed deliveries fail safely;
- event loss/retry exhaustion is observable;
- no GitHub write permission/path exists.

---

## Phase 3 — authenticated human decision actions

Goal: make `Needs Andris` perform real, auditable GitHub decisions from phone.

**Status: NOT STARTED.**

### Prerequisites

- Phase 2 live read-only state is stable;
- Cloudflare Access protects the human control surface;
- Worker cryptographically validates Access JWT issuer/JWKS/audience;
- dedicated GitHub App write permissions are reviewed only for already-implemented actions;
- every action re-reads live GitHub state immediately before mutation.

### Planned actions

- [ ] authenticated `Merge`;
- [ ] `Needs changes` / exact request-change flow;
- [ ] `Later` defer flow;
- [ ] stale-head approval binding;
- [ ] exact-head CI/review revalidation before writes;
- [ ] expected-head merge protection where supported;
- [ ] idempotency + audit records;
- [ ] optional `Retry CI` only after exact semantics/minimum permission are proven.

### Must not do

- Merge authorization is never production deploy authorization;
- no production DB/host/root action from a GitHub decision;
- no broad Contents-write permission by default;
- no mutation from cached-only evidence.

### Exit gate

A real PR can be safely decided from the phone, stale approvals are rejected, the mutation is auditable, and GitHub policy cannot be bypassed.

---

## Phase 4 — notifications + deterministic continuation

Goal: reduce normal interaction to meaningful human gates.

**Status: FUTURE.**

### Planned deliverables

- [ ] Telegram and/or web push;
- [ ] deep links to exact decision cards;
- [ ] transition-based deduplication/noise control;
- [ ] safe project/campaign pause controls;
- [ ] deterministic next-eligible task/campaign state;
- [ ] optional ChatGPT Scheduled Task + connected GitHub-app pilot.

Do not assume unattended connected-app writes are supported. If they are not, keep the bridge read/notify/continuation-state only.

---

## Phase 5 — production visibility

Goal: show production truth without weakening the existing RPi5 production boundary.

**Status: FUTURE.**

### Planned deliverables

- [ ] sanitized read-only RPi5 adapter;
- [ ] GitHub main SHA vs production SHA;
- [ ] deploy class;
- [ ] runtime/health/rollback evidence;
- [ ] drift/blocker display.

### Must not do

- no direct Control SSH/sudo mutation;
- no production DB writes;
- no bypass of `RPi5_main` controller/helper gates.

---

## Final optional phase — AI/agent runtime

Only after the approval/control product is proven valuable.

MVP and Phases 0–5 must not depend on OpenAI API, Claude API, AI Gateway, Sandbox SDK or autonomous coding workers.
