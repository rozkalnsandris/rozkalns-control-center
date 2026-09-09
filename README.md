# Rozkalns Control

Mobile-first control and approval plane for Andris' engineering projects.

> **Current source state:** Phase 5 is active. Phases 0–4 are complete for the bounded chains recorded by canonical handoff #278. The repository contains the Cloudflare Worker/React control plane, live GitHub read composition, D1-backed control state, webhook/Queue reconciliation, guarded Merge / Needs changes / Later routes, Telegram notification transport source/configuration, deterministic continuation source, and the merged authenticated Phase 5 RPi5 observation path: strict sanitized evidence, Ed25519 exact-byte delivery verification, bounded key lookup, durable replay claim, atomic monotonic projection acceptance, dormant Worker runtime wiring, plus the merged GET/SELECT-only production-readiness preflight. Repository source and configuration describe intended behavior; they do not independently prove current production state.

Durable Phase 5 boundary markers:

- `SOURCE_READY_LIVE_UNPROVEN`
- `READONLY_PREFLIGHT_EVIDENCE_ONLY`
- `MERGE_NOT_DEPLOY_AUTHORITY`

The canonical product and architecture contract is GitHub issue **#1 — `[MASTER / READ FIRST] Rozkalns Control — product contract, architecture and delivery roadmap`**. GitHub issue **#278** is the canonical operational handoff for mutable phase/live continuity. Read both before work that depends on runtime status or crosses a trust boundary.

## What this product is for

The normal daily flow is:

`work progresses → Needs Andris → phone notification → review evidence → Merge / Needs changes / Later → close phone → safe automation continues`

The MVP is focused on trustworthy approvals, notifications and production visibility rather than AI-provider integration.

### MVP

- Android-first `Needs Andris` queue;
- project, issue, PR, CI and review visibility;
- deterministic `Merge`, `Needs changes` and `Later` actions;
- fresh exact-head/SHA, CI, review and policy revalidation before mutations;
- quiet notifications with deep links to the exact decision;
- sanitized production visibility without direct RPi5 access;
- existing GitHub and RPi5 automation remains authoritative after merge;
- no OpenAI or Claude API requirement.

### Not MVP

- autonomous AI coding workers;
- Cloudflare Sandbox SDK or AI Gateway;
- direct RPi5 SSH, sudo or production mutation;
- bypasses around repository rules, exact-head checks or owner live gates.

## Managed project scope

- `rozkalnsandris/hermes-tech`
- `rozkalnsandris/hermes-deals`
- `rozkalnsandris/rozkalns-cv`
- `rozkalnsandris/RPi5_main`
- `rozkalnsandris/ops-workflows`
- `rozkalnsandris/rozkalnsandris`

`rozkalnsandris/hermes-email-skill` is explicitly excluded.

## Trust boundaries

- **GitHub** is canonical for repositories, commits, issues, PRs, reviews, rules and CI.
- **Rozkalns Control** stores bounded normalized projections, decision audit/idempotency records, deferrals, notification state and reconciliation evidence. It must re-read GitHub before state-dependent GitHub mutations.
- **Cloudflare** hosts the Worker/static application and supplies D1, Queue/DLQ, Access and runtime observability boundaries described by source configuration.
- **ChatGPT** may be the reasoning/operator layer through connected tools, but chat memory is never canonical continuation state.
- **RPi5** remains the production trust boundary for exact-SHA deployment, health and rollback. Control must not create a direct host shortcut.

**Merge authorization is not deployment authorization. Source readiness is not production evidence.** `MERGE_NOT_DEPLOY_AUTHORITY` and `SOURCE_READY_LIVE_UNPROVEN` are durable invariants, not temporary status text.

## Current source architecture

### Browser and Worker

- React + TypeScript + Vite provide the mobile-first dashboard and decision UI.
- Cloudflare Workers Static Assets serve the SPA; `/api/*` is routed through the Worker first.
- Static and Worker API responses use compatibility-tested security headers; sensitive/live API responses remain `Cache-Control: no-store`.
- Dashboard freshness and clock-skew limits remove mutation authority from stale, future or invalid evidence.

### GitHub reads and decisions

The Worker source exposes `GET /api/github/dashboard` for bounded live dashboard reads and contains bounded GitHub App read sessions with normalized exact-head PR/CI/review/policy evidence. State-dependent mutation preflights use fresh unconditional authoritative reads.

Access-authenticated decision routes exist in source for:

- `POST /api/github/needs-changes`;
- `POST /api/github/merge`;
- `POST /api/github/later`.

Decision execution is project-capability gated and binds actor, expected head, fresh observed state and idempotency/audit evidence. The existence of a route or source binding does not create standing authority to invoke it.

### Webhook, Queue and D1

- `POST /api/github/webhook` verifies GitHub HMAC over raw bytes before payload trust.
- Accepted delivery IDs are durably claimed through the `CONTROL_DB` D1 binding and enqueue bounded reconciliation messages.
- Queue messages are **at-least-once, potentially duplicate and not ordered**. Correctness comes from durable D1 state transitions, idempotency and authoritative rereads—not delivery order or `max_concurrency = 1`.
- The main consumer performs authoritative GitHub rereads; the DLQ path records bounded terminal evidence.
- Source-controlled D1 migrations define reconciliation, decision-audit, notification, continuation, Later and Phase 5 observation state. Migration `0010_webhook_observability_hot_index.sql` provides the planner-proven partial index for active webhook-delivery diagnostics. A migration in source is not evidence that it has been applied remotely.
- D1 Free-plan daily row-read/row-write limits are enforced. If D1 queries fail because limits or service availability are exhausted, protected actions must fail closed rather than infer authorization from missing persistence/reconciliation evidence.

### Notifications and continuation

Telegram notification transport is implemented in source/configuration, including the notification dispatch Queue, target selection and required secret names. Canonical #278 records the bounded Phase 4 Gate B chain as completed historical evidence.

This does **not** prove the current Telegram bot secret, chat target, provider availability, Queue backlog or active Worker version. Completed notification authorizations are non-reusable.

Deterministic continuation planning/reservation/persistence/recovery exists in source. Phase 4 completion does not create blanket autonomous continuation or reusable mutation authority.

### Phase 5 production visibility

The dashboard model can represent source/main SHA, production SHA, deploy impact, runtime, health, rollback and blockers. The strict Control consumer accepts only an exact top-level allowlist of **already-sanitized** RPi5 evidence and rejects extra fields before project/SHA/freshness/state validation.

The merged post-#596 source path now extends beyond the earlier producer/transport boundary:

`sanitized evidence → Ed25519 exact-byte verification → exact keyId lookup → durable replay claim → strict normalization → transactional replay + monotonic projection acceptance → dormant Worker route/runtime`.

Source-controlled migrations `0011_rpi5_observation_replay_claims.sql`, `0012_rpi5_production_visibility_projection.sql` and `0013_rpi5_observation_atomic_acceptance.sql` support that path. Their presence in Git does not prove remote D1 application.

The route is dormant unless `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED` is exactly `"true"`. Verification-key material is protected configuration under `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS`; values must never be committed, logged or exported as evidence.

PR #596 merged a manually dispatched production-readiness classifier that binds to exact `main` + successful exact-main CI, uses Workers GET-only inventory and D1 single-`SELECT` queries with explicit zero-mutation provider evidence. Its result is `READONLY_PREFLIGHT_EVIDENCE_ONLY`: PASS or FAIL can classify a baseline, but cannot authorize migration apply, key provisioning, Worker activation/deploy or RPi5 signer/runtime delivery.

No direct Control-to-RPi5 SSH, sudo, generic helper, protected filesystem/runtime inspection or credential path is permitted. The full durable source/evidence/activation contract and classification matrix are in [`docs/PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](docs/PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md).

## Runtime configuration versus deployed state

[`wrangler.jsonc`](wrangler.jsonc) declares production-shaped source inputs including Worker/static-assets routing, D1 and Queue bindings, notification/Telegram configuration keys, Access issuer/audience identifiers, required secret names and observability sampling.

These declarations are deploy inputs only. Before any live action, use canonical #278 and the focused tracker to obtain fresh GET-only evidence and the exact authorization required by the owning repository contract. Even a previously successful read-only preflight is a bounded observation, not durable proof of current state.

## Phase summary

- **Phase 0:** repository, policy and architecture contracts complete.
- **Phase 1:** mobile-first deterministic UI baseline complete.
- **Phase 2:** live-read/GitHub App/webhook/D1/Queue foundation established; current production facts remain separately evidenced.
- **Phase 3:** bounded Merge / Needs changes / Later chain complete; no completed canary creates standing mutation authority.
- **Phase 4:** bounded Telegram notification / deterministic-continuation chain complete; historical receipts are terminal and non-reusable.
- **Phase 5:** active; the authenticated observation ingestion/runtime chain and GET/SELECT-only production-readiness preflight are merged at source level. Current production baseline, applied schema, protected key material, activation state, RPi5 signer/runtime and delivered observation evidence remain freshly evidenced and/or separately LIVE-gated (`SOURCE_READY_LIVE_UNPROVEN`).
- **Optional AI/runtime phase:** deferred.

See [`docs/ROADMAP_CURRENT_CHECKPOINT.md`](docs/ROADMAP_CURRENT_CHECKPOINT.md) for the durable current checkpoint, [`docs/ROADMAP.md`](docs/ROADMAP.md) for the current long-form phase contract, [`docs/PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](docs/PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md) for the Phase 5 operator contract, and [`docs/ROADMAP_HISTORY.md`](docs/ROADMAP_HISTORY.md) for preserved implementation chronology.

## Local development and validation

The repository requires Node.js `24.19.0`.

```bash
npm ci
npm run check
```

For browser regression tests, provide Chromium and ChromeDriver and run:

```bash
npm run test:browser
```

For local development:

```bash
npm run dev
```

`worker-configuration.d.ts` is generated by `wrangler types` and is intentionally not committed. There is intentionally no ordinary deploy script; production/live work uses separately reviewed, fail-closed gates.

## Repository map

- [`AGENTS.md`](AGENTS.md) — mandatory repository operating rules;
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution and PR workflow;
- [`SECURITY.md`](SECURITY.md) — security policy;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current system boundaries and component architecture;
- [`docs/STATE_MODEL.md`](docs/STATE_MODEL.md) — deterministic task/approval state contract;
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — threats and required mitigations;
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — current phase gates and durable sequencing;
- [`docs/ROADMAP_CURRENT_CHECKPOINT.md`](docs/ROADMAP_CURRENT_CHECKPOINT.md) — durable current source/gate checkpoint;
- [`docs/PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](docs/PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md) — Phase 5 observation architecture, readonly-preflight matrix, activation dependency order and trust-boundary checklist;
- [`docs/ROADMAP_HISTORY.md`](docs/ROADMAP_HISTORY.md) — preserved historical implementation chronology;
- [`docs/D1_HOT_QUERY_AUDIT.md`](docs/D1_HOT_QUERY_AUDIT.md) — operational query-plan and index evidence;
- [`docs/WORKER_OBSERVABILITY.md`](docs/WORKER_OBSERVABILITY.md) — structured logging and sampling contract;
- [`docs/adr/`](docs/adr/) — durable architecture decisions.

## Development rule

Before every task:

1. re-read master issue #1 and current handoff #278;
2. identify the current phase and first incomplete gate;
3. inspect repository instructions, canonical GitHub state and the relevant implementation;
4. work only the authorized scope and necessary prerequisites;
5. validate narrowly first, then run required broader checks;
6. use a task branch and focused Draft PR;
7. never interpret merge or source configuration as production authorization.

No secrets belong in this public repository.
