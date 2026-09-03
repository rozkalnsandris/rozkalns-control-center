# Rozkalns Control

Mobile-first control and approval plane for Andris' engineering projects.

> **Current source state:** Phase 3 is active. The repository now contains a Cloudflare Worker and React application with live GitHub read composition, D1-backed control state, webhook-to-Queue reconciliation, and guarded human decision routes. Repository source and configuration describe the intended runtime; they do not, by themselves, prove what is currently deployed or enabled in production.

The canonical product and phase contract is GitHub issue **#1 — `[MASTER / READ FIRST] Rozkalns Control — product contract, architecture and delivery roadmap`**. GitHub issue **#278** is the canonical operational handoff for changing current phase or live state. Read both before work that depends on runtime status or crosses a trust boundary.

## What this product is for

The normal daily flow should become:

`work progresses → Needs Andris → phone notification → review evidence → Merge / Needs changes / Later → close phone → safe automation continues`

The first useful release is focused on trustworthy approvals and visibility rather than AI-provider integration.

### MVP

- Android-first `Needs Andris` queue;
- project, issue, PR, CI and review visibility;
- deterministic `Merge`, `Needs changes` and `Later` actions;
- fresh exact-head/SHA, CI, review and policy revalidation before mutations;
- quiet notifications with deep links to the exact decision;
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

`rozkalnsandris/hermes-email-skill` is explicitly excluded from the initial scope.

## Trust boundaries

- **GitHub** is canonical for repositories, commits, issues, PRs, reviews, rules and CI.
- **Rozkalns Control** stores bounded normalized projections, decision audit/idempotency records, deferrals, notification state and reconciliation evidence. It must re-read GitHub before state-dependent GitHub mutations.
- **Cloudflare** hosts the Worker/static application and supplies D1, Queue/DLQ, Access and runtime observability boundaries described by source configuration.
- **ChatGPT** may be the reasoning/operator layer through connected tools, but chat memory is never canonical continuation state.
- **RPi5** remains the production trust boundary for exact-SHA deployment, health and rollback. Control must not create a direct host shortcut.

**Merge authorization is not deployment authorization. Source readiness is not production evidence.**

## Current source architecture

### Browser and Worker boundary

- React + TypeScript + Vite provide the mobile-first dashboard and decision UI.
- Cloudflare Workers Static Assets serve the SPA; `/api/*` is routed through the Worker first.
- [`public/_headers`](public/_headers) defines the static-asset CSP and browser security headers. Worker-generated API responses receive the corresponding centralized policy in `src/worker/response-security.ts` and sensitive/live responses remain `Cache-Control: no-store`.
- The client uses one bounded read-only fetch contract for health, dashboard and webhook-observability reads. Timeout, navigation abort, network/server failure and invalid payloads are distinct outcomes; the last successful snapshot may remain visible but loses fresh authority.
- Dashboard timestamps have explicit maximum-age and clock-skew limits. Invalid, future or over-age evidence is visibly stale/unknown and keeps all mutation-capable UI disabled.

### GitHub reads and operator evidence

The Worker registers read paths for:

- `GET /api/health`;
- `GET /api/github/dashboard`;
- `GET /api/github/reconcile`;
- `GET /api/github/needs-changes/preflight`;
- `GET /api/github/webhook-deliveries`.

The GitHub App integration uses short-lived installation credentials inside a dedicated credential boundary, repository-scoped REST GET sessions, and a fixed GraphQL merge-state query. Read results are normalized into exact-head PR, CI, review and branch-policy evidence; incomplete or contradictory evidence fails closed.

Read-only reconciliation may opt into bounded conditional REST requests. Cached bodies and `ETag` validators are bound to the installation identity, selected repository scope, permissions, exact repository, endpoint and query. `304 Not Modified` is an explicit typed outcome. Merge, Needs changes and other state-dependent mutation preflights remain unconditional authoritative reads.

The dashboard exposes sanitized GitHub rate-limit evidence as `HEALTHY`, `ATTENTION`, `EXHAUSTED` or `UNKNOWN`. Missing or malformed headers are `UNKNOWN`; the Worker does not sleep or automatically retry inside a user request.

### Webhook, Queue and D1 durability

- `POST /api/github/webhook` verifies the webhook HMAC over raw bytes before trusting repository or event identity.
- Accepted deliveries are claimed in D1 by delivery ID and enqueue a bounded identity-only reconciliation message.
- The main Queue consumer performs authoritative GitHub rereads and records the delivery lifecycle; the DLQ consumer persists bounded terminal evidence. Queue messages are triggers, never canonical decision evidence.
- `GET /api/github/webhook-deliveries` projects bounded, sanitized `HEALTHY | ACTIVE | ATTENTION` evidence. It exposes counts and diagnostics only—no retry, requeue, delete or cleanup control.
- Migrations `0001`–`0009` define reconciliation, decision-audit, notification, continuation and Later state. Migration `0010_webhook_observability_hot_index.sql` adds one planner-proven partial observability index. It is source-controlled but was not applied to remote D1 by issue #529.

Operational D1 query shapes and `EXPLAIN QUERY PLAN` evidence are documented in [`docs/D1_HOT_QUERY_AUDIT.md`](docs/D1_HOT_QUERY_AUDIT.md). The schema deliberately excludes raw webhook bodies and credentials.

### Human decisions

The Worker source registers Access-authenticated routes for:

- `POST /api/github/needs-changes`;
- `POST /api/github/merge`;
- `POST /api/github/later`.

Decision execution is project-capability gated and binds the actor, expected head, fresh observed head and idempotency/audit state. Merge and Needs changes re-resolve live GitHub evidence before their writes; Later revalidates a deterministic material-state fingerprint before D1 persistence.

The existence of these routes or their bindings in source does not grant standing authority to invoke them. Current live state and any next activation/canary are governed by #1, #278 and the relevant focused tracker.

### Notifications, continuation and production visibility

- Notification transitions, intents, attempts and dispatch claims have D1 contracts and Queue-oriented runtime composition, but no notification-provider secret/transport is configured by this repository baseline.
- Deterministic continuation planning, reservation, persistence and recovery exist in source. The continuation runtime is not registered on a Worker route, Queue handler or scheduler and remains explicitly opt-in.
- Production visibility has a sanitized source model and dashboard projection. A GET-only preflight workflow can compare exact source and Worker evidence, but no Control-to-RPi5 production adapter is connected; fixtures and repository source do not prove current host state.

## Runtime configuration versus deployed state

[`wrangler.jsonc`](wrangler.jsonc) declares the production-shaped source contract:

- Worker/static-assets routing and version metadata;
- the `CONTROL_DB` D1 binding;
- reconciliation Queue producer, consumer and DLQ consumer settings;
- live-read and webhook-runtime feature flags;
- Access issuer/audience identifiers for decision routes;
- required secret names, never secret values;
- persisted logs sampled at `0.10` and traces sampled at `0.05`.

These declarations are deploy inputs, not proof that a particular version, migration, binding, permission or capability is active. Before any live action, use the current #278 handoff and focused tracker to perform fresh GET-only preflight and obtain the exact authorization required by the repository contract.

Structured Worker and Queue logs use fixed route/outcome/error fields and safe correlation/version evidence. They exclude query values, request/response bodies, Access credentials, GitHub tokens/JWTs/private keys, webhook signatures and protected configuration. See [`docs/WORKER_OBSERVABILITY.md`](docs/WORKER_OBSERVABILITY.md).

## Phase summary

- **Phase 0:** repository, policy and architecture contracts complete.
- **Phase 1:** mobile-first deterministic UI baseline complete.
- **Phase 2:** live-read, GitHub App, webhook, D1 and Queue source architecture implemented; production facts remain separately evidenced.
- **Phase 3:** authenticated human decisions active as the current product phase; each production capability/action remains independently gated.
- **Phase 4:** notification and deterministic-continuation source foundations implemented; activation/transport remains gated.
- **Phase 5:** sanitized production-visibility model and UI implemented; RPi5 adapter/runtime evidence remains gated.
- **Optional AI/runtime phase:** deferred.

See [`docs/ROADMAP_CURRENT_CHECKPOINT.md`](docs/ROADMAP_CURRENT_CHECKPOINT.md) for the durable current checkpoint. Historical phase documents preserve the design and evidence applicable when each slice was delivered; where wording conflicts with current source, the current source, issue #1 and issue #278 take precedence.

## Local development and validation

The repository requires Node.js `24.19.0`.

```bash
npm ci
npm run check
```

For the browser regression suite, provide Chromium and ChromeDriver, then run:

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
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system boundaries and component architecture;
- [`docs/STATE_MODEL.md`](docs/STATE_MODEL.md) — deterministic task/approval state contract;
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — threats and required mitigations;
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — long-form phase gates and exit criteria;
- [`docs/ROADMAP_CURRENT_CHECKPOINT.md`](docs/ROADMAP_CURRENT_CHECKPOINT.md) — durable current source/gate checkpoint;
- [`docs/D1_HOT_QUERY_AUDIT.md`](docs/D1_HOT_QUERY_AUDIT.md) — operational query-plan and index evidence;
- [`docs/WORKER_OBSERVABILITY.md`](docs/WORKER_OBSERVABILITY.md) — structured logging and sampling contract;
- [`docs/adr/`](docs/adr/) — durable architecture decisions.

## Development rule

Before every task:

1. re-read master issue #1 and current handoff #278;
2. identify the current phase and first incomplete exit criterion;
3. inspect repository instructions, canonical GitHub state and the local worktree;
4. work only the authorized scope and necessary prerequisites;
5. validate narrowly first, then run the required broader checks;
6. use a task branch and focused Draft PR;
7. never interpret merge or source configuration as production authorization.

No secrets belong in this public repository.
