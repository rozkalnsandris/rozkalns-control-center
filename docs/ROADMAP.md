# Delivery Roadmap

This file is the current repository-local phase contract. Master issue #1 remains the canonical product/architecture contract and issue #278 remains the canonical operational handoff for mutable live/current state. Detailed implementation chronology is preserved in [`ROADMAP_HISTORY.md`](ROADMAP_HISTORY.md).

Last reconciled: **2026-09-10**.

Durable Phase 5 boundary markers:

- `SOURCE_READY_LIVE_UNPROVEN`
- `READONLY_PREFLIGHT_EVIDENCE_ONLY`
- `MERGE_NOT_DEPLOY_AUTHORITY`

## Evidence boundary

Repository source, tests and configuration prove intended implementation only. They do **not** independently prove the currently deployed Worker version/traffic, applied D1 migrations, Queue state, secret/binding values, GitHub App grants, Cloudflare Access/routes or RPi5 runtime state.

Historical live canaries prove only their bounded completed action. Consumed one-shot authorizations never become standing authority. A successful read-only preflight is similarly a bounded observation, not durable proof of future production state and not LIVE authorization.

Cloudflare Queue messages are at-least-once and may be duplicated; delivery ordering is not guaranteed. Correctness comes from durable domain/D1 state, idempotency and authoritative rereads.

A source-controlled migration is a deploy input. Source merge does not prove remote apply or deployment (`MERGE_NOT_DEPLOY_AUTHORITY`).

## Current phase classification

- **Phase 0 — repository + contracts:** COMPLETE.
- **Phase 1 — mobile-first deterministic decision UI:** COMPLETE.
- **Phase 2 — live-read GitHub/control-plane foundation:** FOUNDATION ESTABLISHED; current production facts remain separately evidenced.
- **Phase 3 — authenticated human decisions:** COMPLETE for the bounded Merge / Needs changes / Later chain recorded by #278; completed canaries create no standing mutation authority.
- **Phase 4 — notifications + deterministic continuation:** COMPLETE for the bounded Telegram/continuation chain recorded by #278; historical Gate A/Gate B/Later receipts are terminal and non-reusable.
- **Phase 5 — production visibility:** ACTIVE. The authenticated RPi5 observation ingestion/runtime source chain, GET/SELECT-only production-readiness preflight, fail-closed D1 apply executor and fail-closed verification-key provisioning executor are merged at source level. Current GitHub Environment/credential/secret state, remote schema/binding state, ingest activation, deployed Worker state, RPi5 signer/runtime and delivered observation evidence remain unproven by source and separately evidenced/gated (`SOURCE_READY_LIVE_UNPROVEN`).
- **Optional AI/runtime phase:** DEFERRED.

See [`ROADMAP_CURRENT_CHECKPOINT.md`](ROADMAP_CURRENT_CHECKPOINT.md) for the compact durable checkpoint and [`PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md) for the Phase 5 operator contract.

## Current architecture baseline

### GitHub and decision plane

- GitHub remains canonical for repository, SHA, issue, PR, review, rules and CI state.
- The Worker has bounded GitHub App read sessions and normalized exact-head evidence.
- Access-authenticated Worker routes exist for Merge, Needs changes and Later.
- State-dependent mutations re-resolve authoritative GitHub state and fail closed on stale/ambiguous evidence.
- Merge never authorizes deployment, D1/Queue writes outside an exact separately-authorized contract, host work or credential changes.

### Webhook, Queue and D1

- GitHub webhook HMAC is verified over raw request bytes before payload identity is trusted.
- D1 stores bounded reconciliation, decision-audit/idempotency, notification, continuation, Later and Phase 5 observation state.
- Queue/DLQ delivery is a trigger mechanism, not canonical sequencing or authorization evidence.
- Duplicate/out-of-order messages must be harmless through durable lifecycle checks and idempotency.
- D1 quota/service failure is an operational blocker, never a reason to authorize from incomplete state.

### Notifications and continuation

- Telegram transport, target configuration and notification dispatch Queue composition exist in source/configuration.
- Canonical #278 records the bounded Phase 4 Telegram chain as completed historical evidence.
- Repository source does not prove current Telegram credentials, provider availability, target binding, Queue backlog or active Worker version.
- Deterministic continuation source exists, but Phase 4 completion does not create blanket autonomous continuation or reusable authorization.

### Phase 5 production visibility

The source boundary is no longer the old “design a read-only transport” lane. The source path has advanced through the authenticated dormant runtime chain and concrete fail-closed activation preparation:

1. **PR #577** — Ed25519 authenticated outer delivery over exact raw payload bytes.
2. **PR #581** — migration `0011_rpi5_observation_replay_claims.sql` plus durable replay-claim helper.
3. **PR #583** — authenticated ingestion composition from metadata/freshness/signature through replay claim and strict normalization.
4. **PR #585** — bounded verification-key registry with exact `keyId` lookup and no fallback.
5. **PR #587** — dormant-by-default Worker route/runtime source wiring.
6. **PR #590** — migration `0012_rpi5_production_visibility_projection.sql` plus bounded projection store.
7. **PR #592** — migration `0013_rpi5_observation_atomic_acceptance.sql` plus transactional replay/monotonic projection acceptance.
8. **PR #594** — atomic authenticated ingestion/runtime composition wired through the dormant Worker route.
9. **PR #596** — exact-main GET/SELECT-only production-readiness preflight.
10. **PR #599** — hardened predecessor migration `0010_webhook_observability_hot_index.sql` / index classification before deriving the D1 migration ceiling.
11. **PR #604** — manual-only fail-closed Phase 5 production D1 apply executor source.
12. **PR #606** — dedicated `production-d1-live` GitHub Environment binding for the D1 executor source contract.
13. **PR #612** — manual-only fail-closed verification-key provisioning executor source for `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS`.

The earlier strict Control consumer and RPi5 producer sanitization/provenance contracts remain prerequisites to this chain. Control still accepts only already-sanitized ten-field evidence and must not use direct SSH/sudo/root/protected-host inspection to acquire it.

The runtime remains dormant unless `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED` is exactly `"true"`. `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS` is protected configuration. Source now contains a concrete provisioning executor, but source does not prove that its dedicated GitHub Environment, write credential, registry secret or production binding is configured or that the executor has ever run. Migrations `0010`–`0013` and D1 executor source similarly do not prove current remote D1 state.

The merged readonly preflight binds evidence to exact current `main` and successful exact-main CI; inventories Worker state with GET-only APIs; validates `CONTROL_DB`; classifies dormant ingest and protected verification-key binding presence/type; and permits only single-statement D1 `SELECT` queries that prove zero mutation. Its outcome is `READONLY_PREFLIGHT_EVIDENCE_ONLY`.

For the exact classification matrix, source executor contracts, future activation dependency graph and trust-boundary checklist, use [`PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md) and [`PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md`](PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md).

## Current gates

### Read-only evidence gate

A fresh Phase 5 production baseline may be classified using the merged GET/SELECT-only preflight when canonical continuity calls for it. This is a technical/read-only checkpoint, not an owner mutation gate. Never rerun a historical workflow merely because a prior result exists; fresh state and the current focused contract determine whether another observation is appropriate.

A PASS means only that the observed baseline is internally consistent enough for separately-authorized activation planning. A FAIL is diagnosis only. Neither permits production mutation (`READONLY_PREFLIGHT_EVIDENCE_ONLY`).

### Source readiness versus LIVE dependencies

The source contract has concrete fail-closed executors for `D1_APPLY` and `VERIFICATION_KEY_PROVISION`. Their existence does not satisfy or authorize their LIVE prerequisites.

`WORKER_ACTIVATE` is the **next incomplete Control source mutation class**. The machine contract defines its trust/authority boundary, but source does not yet contain a concrete activation candidate manifest/executor. The queued source-only preparation sequence begins with issue #614. Issue #611 is completed source history after PR #612 and is not a current lane.

If fresh evidence shows activation work is required, the LIVE dependency ordering remains:

`fresh baseline → separately authorized D1 migration apply if needed → separately authorized verification-key provisioning → separately authorized Worker configuration/deploy/activation → separately authorized RPi5 signer/private-key/runtime delivery → read-only reconciliation`.

Every mutation-bearing step is separately owner/LIVE gated. Source work on `WORKER_ACTIVATE` preparation does not skip or satisfy an earlier LIVE prerequisite. Do not infer authority from a green preflight, merged source or prior canary.

## Explicit owner-gated work

The following remain separately gated and are never implied by source readiness or merge:

- Worker upload/deployment/promotion/route activation;
- applying D1 migrations or production D1 writes;
- Queue mutation/replay/cleanup/configuration change;
- observation verification-key/private-key provisioning, rotation or export;
- production ingest/binding mutation;
- production decision-route invocation/canaries outside exact authorization;
- GitHub App permission/repository-selection or repository settings/ruleset changes;
- Cloudflare Access/DNS/Tunnel/domain/binding/infrastructure mutation;
- RPi5 signer/runtime/host/root/systemd/Docker/network/helper mutation;
- rollback/cutover/destructive cleanup.

## Next safe step

For source-level continuation after the post-#612 continuity reconciliation, use queued issue #614 to define the exact `WORKER_ACTIVATE` candidate manifest. That source lane remains preparation only and must preserve `SOURCE_READY_LIVE_UNPROVEN` and `MERGE_NOT_DEPLOY_AUTHORITY`.

For any production decision, fresh-read canonical #278 plus current GitHub/runtime evidence and stop at the exact owner/LIVE boundary defined by the current focused tracker. Do not resume #611; it is completed source history. Do not create another source lane merely because older roadmap text named #574 or #576 as current.

## Historical implementation chronology

The former long-form chronological roadmap is preserved in [`ROADMAP_HISTORY.md`](ROADMAP_HISTORY.md). Historical `CURRENT`, `NOT STARTED`, SHA, CI and RPi5 statements there describe evidence available when written and are **not** current authority. For present state use this file, [`ROADMAP_CURRENT_CHECKPOINT.md`](ROADMAP_CURRENT_CHECKPOINT.md), [`PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md), master #1 and canonical handoff #278.
