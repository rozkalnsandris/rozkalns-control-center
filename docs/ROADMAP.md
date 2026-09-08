# Delivery Roadmap

This file is the current repository-local phase contract. Master issue #1 remains the canonical product/architecture contract and issue #278 remains the canonical operational handoff for mutable live/current state. The detailed implementation chronology that previously lived below the current-status override is preserved unchanged in [`ROADMAP_HISTORY.md`](ROADMAP_HISTORY.md).

Last reconciled: **2026-09-08**.

## Evidence boundary

Repository source, tests and configuration prove the intended implementation baseline only. They do **not** independently prove the currently deployed Worker version, traffic/routing, applied D1 migrations, Queue state, secret values, Telegram provider state, GitHub App grants, Cloudflare Access/bindings or RPi5 runtime state.

Historical live canaries prove only their bounded completed action. Consumed one-shot authorizations never become standing authority. Any future production/live mutation requires fresh canonical state, GET-only preflight where applicable, exact target/SHA/baseline binding and the explicit authority required by #1, #278 and the focused tracker.

Cloudflare Queue messages are at-least-once and may be duplicated; delivery ordering is not guaranteed. `max_concurrency = 1` is a processing bound, not an ordering guarantee. Sequencing correctness therefore comes from durable domain/D1 state, idempotency and authoritative rereads.

On the Workers Free plan, D1 daily row-read and row-write limits are enforced. When D1 queries fail because a daily limit or service dependency is unavailable, Control must treat persistence/reconciliation evidence as unavailable and fail closed for protected actions.

## Current phase classification

- **Phase 0 — repository + contracts:** COMPLETE.
- **Phase 1 — mobile-first deterministic decision UI:** COMPLETE.
- **Phase 2 — live-read GitHub/control-plane foundation:** FOUNDATION ESTABLISHED. GitHub App reads, webhook verification, D1/Queue reconciliation and supporting source boundaries exist; current production facts remain separately evidenced.
- **Phase 3 — authenticated human decisions:** COMPLETE for the bounded Merge / Needs changes / Later capability and canary chain recorded by #278. Completed canaries create no standing mutation authority.
- **Phase 4 — notifications + deterministic continuation:** COMPLETE for the bounded Telegram transport/continuation chain recorded by #278. Historical Gate A/Gate B/Later receipts are terminal and non-reusable; completion does not prove current provider secret, Queue backlog or Worker state.
- **Phase 5 — production visibility:** ACTIVE. The Control strict consumer and RPi5 producer sanitization/provenance source contracts are merged/source-ready. The authenticated one-way RPi5 -> Control delivery boundary is the current source lane; public-key provisioning, durable replay claims, runtime wiring and live production evidence remain separately gated.
- **Optional AI/runtime phase:** DEFERRED.

[`ROADMAP_CURRENT_CHECKPOINT.md`](ROADMAP_CURRENT_CHECKPOINT.md) records the detailed durable source/gate checkpoint without transient authorization receipts or runtime claims.

## Current architecture baseline

### GitHub and decision plane

- GitHub remains canonical for repository, SHA, issue, PR, review, rules and CI state.
- The Worker has bounded GitHub App read sessions and normalized exact-head evidence.
- Access-authenticated Worker routes exist for Merge, Needs changes and Later.
- State-dependent mutations re-resolve authoritative GitHub state and fail closed on stale/ambiguous evidence.
- Merge never authorizes deployment, D1/Queue writes outside the exact decision contract, host work or credential changes.

### Webhook, Queue and D1

- GitHub webhook HMAC is verified over raw request bytes before payload identity is trusted.
- D1 stores bounded reconciliation, decision-audit/idempotency, notification, continuation and Later state.
- Queue/DLQ delivery is a trigger mechanism; it is not canonical sequencing or authorization evidence.
- Duplicate/out-of-order messages must be harmless through durable lifecycle checks and idempotency.
- A source-controlled D1 migration is a deploy input, not evidence that it has been applied remotely.
- D1 quota/service failure is an operational blocker, never a reason to authorize from incomplete state.

### Notifications and continuation

- Telegram notification transport, target configuration and notification dispatch Queue composition exist in source/configuration.
- Canonical #278 records the bounded Phase 4 Telegram chain as completed historical evidence.
- Repository source does not prove current Telegram credentials, provider availability, target binding, Queue backlog or active Worker version.
- Deterministic continuation source exists, but completion of Phase 4 does not create blanket autonomous continuation or reusable authorization.

### Phase 5 production visibility

- Control can normalize/project source/main SHA, production SHA, deploy impact, runtime, health, rollback and blockers.
- The merged Phase 5 consumer accepts only an exact allowlist of **already-sanitized** RPi5 evidence and rejects extra/inherited/non-enumerable/symbol fields before existing project/SHA/freshness/state checks.
- `RPi5_main` has merged the equivalent-or-tighter producer allowlist/sanitization/provenance source contract. That source contract acquires no production evidence and grants no host/runtime authority.
- Issue #576 defines the outer authenticated delivery source boundary without changing the ten-field payload: strict delivery metadata stays outside the payload, Ed25519 signing binds delivery identity/time/key ID and exact raw payload bytes, and Control is verifier-only.
- Signature verification exposes a replay identity but does not claim durable uniqueness. A later separately reviewed runtime must atomically claim it before trusting the payload; no replay-store binding or write is introduced by this source slice.
- Normalized production evidence is observational only. It does not authorize deploy, DB/data mutation, host changes, rollback or credentials.
- Control must not obtain this evidence through direct SSH, sudo, generic helpers, arbitrary filesystem/runtime inspection or protected host credentials.
- No Worker route, live endpoint, key provisioning, replay persistence or RPi5 host/runtime transport is connected by this source lane. Live evidence remains a separate gate.

## Current gates

### Safe Control source/documentation lane

Issue #576 is the current focused source/documentation/test lane for the authenticated read-only observation transport boundary.

`PHASE5_READ_ONLY_OBSERVATION_TRANSPORT_BOUNDARY`

This lane may define the strict outer delivery contract, signature verification primitives, fail-closed tests and source-only documentation through Draft PR, exact-head CI/review and Ready. Merge remains separately explicit under FAST-LANE.

### Phase 5 runtime dependency

The #576 source boundary does not authorize or implement public-key provisioning, key rotation, durable replay-state claims, Worker route/binding wiring, RPi5 observation/runtime execution or live evidence acquisition. After #576 merges, fresh canonical #278 and current RPi5 continuity must determine the exact next bounded runtime/preflight lane rather than inferring authority from source readiness.

## Explicit owner-gated work

The following remain separately gated and are never implied by source readiness or merge:

- Worker deployment/promotion;
- applying D1 migrations or other production D1 writes;
- Queue mutation/requeue/cleanup;
- production decision-route invocation/canaries outside their exact authorization;
- GitHub App permission/repository-selection changes;
- Cloudflare Access/DNS/routes/bindings mutation;
- secrets or credentials, including observation transport key provisioning/rotation;
- RPi5 host/runtime/root/systemd/Docker/network/helper mutation;
- rollback/cutover.

## Next safe step

Complete issue #576 source boundary through focused validation, Draft PR, exact-head CI/review and Ready, then stop for explicit MERGE. After that merge, use fresh #278 and RPi5 continuity to select the next separately gated public-key/replay/runtime observation step. Source readiness does not prove live production evidence, and no host/runtime execution is authorized by this lane.

## Historical implementation chronology

The former long-form chronological roadmap is preserved unchanged in [`ROADMAP_HISTORY.md`](ROADMAP_HISTORY.md). Historical `CURRENT`, `NOT STARTED`, SHA, CI and RPi5 statements in that file describe the evidence available when they were written and are **not** current authority. For present state use this file, [`ROADMAP_CURRENT_CHECKPOINT.md`](ROADMAP_CURRENT_CHECKPOINT.md), master #1 and canonical handoff #278.
