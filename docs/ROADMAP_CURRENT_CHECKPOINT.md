# Rozkalns Control — Current Roadmap Checkpoint

Last reconciled: **2026-08-14**.

This checkpoint supplements `docs/ROADMAP.md` with the current implementation state after the Phase 2 public UI, GitHub App, D1, live-dashboard, and live-read rollout-gate work completed through `main=51ecbf0cb35c5d2827a3f82f41642582cc91a6e6`.

Master issue #1 remains the canonical product/architecture contract. `docs/ROADMAP.md` remains the long-form historical roadmap. This file exists to provide one current, non-stale phase checkpoint until the long-form roadmap is fully reconciled.

## Current state

- Phase 0 repository/contracts: **COMPLETE**.
- Phase 1 mobile-first fixture UI: **COMPLETE and publicly deployed**.
- `control.rozkalns.net`: **LIVE** behind the existing Cloudflare Access boundary.
- Samsung Galaxy A55 mobile-first polish: **LIVE and visually accepted**.
- dedicated `Rozkalns Control` GitHub App: **LIVE, READ-ONLY**.
- production D1 base migration: **APPLIED**.
- normalized live dashboard source: **MERGED** via PR #102.
- production live-read enable gate: **MERGED**, hardened through PRs #104, #106, #109 and #111.
- production live GitHub reads: **NOT YET PROVEN DEPLOYED in this checkpoint**.
- Phase 3 GitHub write actions: **NOT STARTED / NOT AUTHORIZED**.

Current exact `main`:

`51ecbf0cb35c5d2827a3f82f41642582cc91a6e6`

Exact-main CI:

- CI #214
- run `31834693408`
- event `push`
- `completed/success`

## Phase 1 — public mobile UI

Completed:

- deterministic fixture decision models;
- `Needs Andris` priority hierarchy;
- Working / Waiting, CI Failed, Merge Ready and Projects sections;
- 320–430 CSS px portrait contract;
- Galaxy A55 compact portrait layout;
- semantic `<details>/<summary>` evidence disclosure;
- >=48px Android-oriented primary touch targets;
- visible keyboard focus and text-based status meaning;
- fixture safety preventing GitHub/Cloudflare/RPi5 mutations.

PR #98 mobile polish was merged and deployed. Production screenshots confirmed:

- compact header;
- reduced hero/vertical spacing;
- combined Worker + fixture status strip;
- collapsed evidence summary;
- better action hierarchy;
- no obvious horizontal overflow on A55.

## Phase 2 — live read-only GitHub integration

**Status: CURRENT.**

### Source/read foundation — COMPLETE

Implemented and merged before the current checkpoint:

- six-repository managed allow-list;
- provider-neutral read interface with no mutation methods;
- bounded repository-scoped REST GET transport;
- fixed-query GraphQL PR merge-state transport;
- GitHub App RS256 JWT + short-lived installation-token session boundary;
- exact-head Checks/workflow/review evidence;
- latest-effective rerun selection;
- branch-policy provenance with fail-closed incomplete coverage;
- conditional commit-status coverage (`OBSERVED` vs `NOT_REQUESTED`);
- authoritative read provider;
- Metadata-only active branch-rules reader;
- fail-closed authoritative reconciliation composition;
- webhook HMAC/deduplication/durability source contracts;
- D1 reconciliation schema and idempotency model.

### Dedicated GitHub App — COMPLETE for current read scope

App: `Rozkalns Control`

Known identities:

- App ID `4567356`;
- Client ID `Iv23likDoFtVeWBJfdFS`;
- installation ID `153121564`.

Installed exactly on:

- `rozkalnsandris/hermes-tech`;
- `rozkalnsandris/hermes-deals`;
- `rozkalnsandris/rozkalns-cv`;
- `rozkalnsandris/RPi5_main`;
- `rozkalnsandris/ops-workflows`;
- `rozkalnsandris/rozkalnsandris`.

Explicitly excluded:

- `rozkalnsandris/hermes-email-skill`.

Current read-only permissions:

- Metadata;
- Contents;
- Issues;
- Pull requests;
- Checks;
- Actions.

Still absent by design:

- Commit statuses permission;
- Administration permission;
- all GitHub write permissions.

### Production Cloudflare/D1 foundation — COMPLETE

Cloudflare account:

`70e29dbca0e8363358659102d2b74178`

Worker:

`rozkalns-control`

Production D1:

- binding `CONTROL_DB`;
- database `rozkalns-control-production`;
- UUID `8504e986-faf0-450c-bfb5-41b5dbf8be09`;
- EU jurisdiction;
- source-controlled migrations under `migrations`.

Completed:

- migration `0001_reconciliation_core.sql` applied through a one-shot fail-closed gate;
- `GITHUB_APP_PRIVATE_KEY_PEM` secret binding present;
- GitHub App Client ID / installation ID runtime bindings present;
- workers.dev OFF;
- Preview URLs OFF;
- custom domain `control.rozkalns.net` attached;
- existing-domain redeploy gate merged via PR #100.

The first public Worker rollout exposed ordered deployment-history semantics; PR #96 fixed the rollout verifier to treat Cloudflare deployments as ordered history while still proving the active deployment/version and 100% traffic.

Last production runtime proven directly in this chat before the later source-only live-read gate merges:

- Worker version `ae86a000-845c-47e1-bac5-56a21d35fe07`;
- deployment `faca2dcd-354b-436b-bdb6-4c6a4a56d797`;
- traffic `100%`;
- domain ID `ac685929d45e825df5b5f6b803a9814b6dbf5d9d`;
- public mode `FIXTURE_ONLY`;
- live GitHub reconciliation `DISABLED`;
- existing custom domain preserved.

Do not infer that later source merges changed production. A separately authorized deploy is still required.

### Normalized live dashboard — MERGED

PR #102 merged as:

`9a44222d4986b5b362ea541ed958e70cdae26e75`

It added:

- `GET /api/github/dashboard`;
- one normalized dashboard snapshot over the existing GitHub App runtime;
- exactly six managed repositories;
- real open issue/PR counts;
- real default-branch/main SHA;
- PR identity/title/URL;
- exact-head Checks/workflows/reviews;
- GitHub merge-state observation;
- `Cache-Control: no-store`;
- sanitized failures;
- request-scoped installation-session reuse;
- React single same-origin fetch with `AbortController` cleanup;
- explicit live/disabled/error UI modes;
- live `Open PR` as a semantic `<a>`;
- deterministic fake-provider/session tests with no live GitHub CI network dependency.

### Fail-closed readiness rule — ACTIVE

The observational live dashboard must not fabricate `MERGE_READY` from incomplete branch-policy evidence.

Current rule:

- exact-head CI failure → `CI_FAILED`;
- latest effective `CHANGES_REQUESTED` → `NEEDS_ANDRIS`;
- draft/running/missing/ambiguous evidence → `WAITING`;
- CI pass + GitHub `MERGEABLE/CLEAN` without complete policy evidence → still `WAITING`;
- current observational dashboard must not emit `MERGE_READY`.

Commit statuses remain outside the approved live-dashboard read scope unless repository evidence later proves they are required.

### Production LIVE READ-ONLY gate — SOURCE READY, LIVE ACTION STILL GATED

PR #104 added the production live-read enable gate and changed source configuration to target:

`CONTROL_LIVE_READ_ENABLED="true"`

This is a **source target**, not proof that production has been transitioned.

PR #106 hardened SPA/API routing:

- Worker-first `/api/*` routing is explicit;
- control-plane responses must satisfy the JSON media-type boundary;
- dashboard routing/canary behavior is deterministic.

PR #109 made the production gate Cloudflare Access-aware:

- existing Access protection is preserved;
- no bypass/public API exception/service-auth policy is introduced;
- operator-supplied user Access token is only canary authentication;
- the Access token is scrubbed from child process environments.

PR #111 hardened the canary sequence:

- prewrite Access canary uses stable `GET /api/health` on the currently deployed Worker;
- fixture-only runtime state is separately proved from the current active Worker binding;
- postdeploy verification uses `GET /api/github/dashboard`;
- both canary responses must cross the expected JSON boundary;
- no blind retry is allowed after `DEPLOY_STARTED=YES`.

Current source baseline for any live-read activation is therefore:

`51ecbf0cb35c5d2827a3f82f41642582cc91a6e6`

with exact-main CI #214 / run `31834693408` successful.

### Immediate next production gate

Do not deploy from merge alone.

Required sequence:

1. fresh-read current `main` and exact-main CI;
2. fresh-read current Cloudflare active Worker version/deployment/domain identity;
3. confirm current production Worker still has the expected pre-transition binding state;
4. obtain a fresh owner-present Cloudflare Access user token for canary authentication without printing/persisting it;
5. use a fresh temporary `rozkalns-control-setup` Cloudflare API token;
6. generate the exact one-shot owner authorization from the live-read gate plan;
7. owner explicitly authorizes that exact main/CI/version/deployment/domain tuple;
8. run the single strict Worker deploy;
9. after `DEPLOY_STARTED=YES`, never blind retry after failure;
10. postverify exact active version/deployment/domain and 100% traffic;
11. Access-authenticated `GET /api/github/dashboard` must return normalized JSON live data;
12. verify only the six managed repositories appear;
13. verify `Open PR` navigation is real while GitHub write actions remain unavailable;
14. record production evidence and consume the authorization.

Until a successful gate execution is recorded, treat production live GitHub reads as **not yet proven active**.

### Remaining Phase 2 durability work

Still not live/completed:

- authenticated GitHub App webhook event activation;
- webhook secret binding;
- Queue binding;
- DLQ binding;
- producer/consumer runtime handlers;
- bounded retries and observable retry exhaustion;
- atomic durable production delivery transitions;
- UI projection of reconciliation/DLQ failures;
- evidence-based decision on whether legacy Commit statuses are needed;
- evidence-based decision on whether an Administration/classic-protection canary is genuinely required.

### Phase 2 permanent boundaries

- no GitHub source writes;
- no live Merge mutation;
- no review/comment/rerun mutation;
- no permission expansion for convenience;
- no RPi5/root mutation;
- merge authorization ≠ production deploy authorization;
- no AI execution.

### Phase 2 exit gate

Phase 2 is complete only when:

- the production dashboard deterministically matches GitHub for managed repositories;
- stale/unknown/partial evidence fails closed;
- invalid/replayed deliveries fail safely;
- event loss/retry exhaustion is observable;
- no GitHub write permission/path exists.

## Phase 3 — authenticated human decision actions

**Status: NOT STARTED.**

Goal: make `Needs Andris` perform real, auditable GitHub decisions from phone.

Prerequisites:

- stable Phase 2 live read-only state;
- Cloudflare Access protecting the human surface;
- Worker-side cryptographic Access JWT validation for mutation routes;
- least-privilege GitHub App write permissions only for already-implemented actions;
- live exact-head revalidation immediately before every mutation.

Planned:

- authenticated `Merge`;
- `Needs changes` / request-change flow;
- `Later` defer flow;
- stale-head approval binding;
- exact-head CI/review revalidation;
- expected-head merge protection where supported;
- idempotency/audit records;
- optional `Retry CI` only after exact semantics and minimum permission are proven.

Merge must never imply production deployment.

## Phase 4 — notifications + deterministic continuation

**Status: FUTURE.**

Planned:

- Telegram and/or web push;
- deep link to exact decision card;
- transition-based deduplication;
- safe pause controls;
- deterministic next-eligible work state;
- optional ChatGPT Scheduled Task + connected GitHub bridge pilot.

Do not assume unattended connected-app writes are supported. If unsupported, keep the bridge read/notify/continuation-state only.

## Phase 5 — production visibility

**Status: FUTURE.**

Planned:

- sanitized read-only RPi5 adapter;
- GitHub main SHA vs production SHA;
- deploy class;
- runtime/health/rollback evidence;
- drift/blocker display.

Control must not gain direct SSH/sudo/root or production DB write capability.

## Final optional phase — AI/agent runtime

Only after the approval/control product is proven valuable. The MVP and Phases 0–5 must not depend on an AI API or autonomous coding runtime.
