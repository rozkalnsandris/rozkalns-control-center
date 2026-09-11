# Delivery Roadmap

This file is the current repository-local phase contract. Master issue #1 remains the canonical product/architecture contract and issue #278 remains the canonical operational handoff for mutable live/current state. Detailed implementation chronology is preserved in [`ROADMAP_HISTORY.md`](ROADMAP_HISTORY.md).

Last reconciled: **2026-09-11**.

Durable Phase 5 boundary markers:

- `SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN`
- `SOURCE_READY_LIVE_UNPROVEN`
- `READONLY_PREFLIGHT_EVIDENCE_ONLY`
- `MERGE_NOT_DEPLOY_AUTHORITY`

## Evidence boundary

Repository source, tests and configuration prove intended implementation only. They do **not** independently prove the currently deployed Worker version/traffic, applied D1 migrations, Queue state, secret/binding values, GitHub App grants, Cloudflare Access/routes or RPi5 runtime state.

Historical live canaries prove only their bounded completed action. Consumed one-shot authorizations never become standing authority. A successful read-only preflight is similarly a bounded observation, not durable proof of future production state and not LIVE authorization.

A source-controlled migration is a deploy input. Source merge does not prove remote apply or deployment (`MERGE_NOT_DEPLOY_AUTHORITY`).

## Current phase classification

- **Phase 0 — repository + contracts:** COMPLETE.
- **Phase 1 — mobile-first deterministic decision UI:** COMPLETE.
- **Phase 2 — live-read GitHub/control-plane foundation:** FOUNDATION ESTABLISHED; current production facts remain separately evidenced.
- **Phase 3 — authenticated human decisions:** COMPLETE for the bounded Merge / Needs changes / Later chain recorded by #278; completed canaries create no standing mutation authority.
- **Phase 4 — notifications + deterministic continuation:** COMPLETE for the bounded Telegram/continuation chain recorded by #278; historical receipts are terminal and non-reusable.
- **Phase 5 — production visibility:** CONTROL SOURCE CHAIN COMPLETE / LIVE UNPROVEN. The authenticated observation ingestion/runtime chain, exact-main GET/SELECT-only preflight, fail-closed D1 apply and verification-key executors, Worker activation candidate/executor, GET-only post-activation verifier, sanitized RPi5 signer handoff, signed-observation reconciliation, production-visibility health UI and drift-notification model are merged at source level. Current production Environment/credential/secret state, remote D1/binding state, active Worker state, RPi5 signer/runtime and delivered observation evidence remain separately evidenced and separately authorized (`SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN`).
- **Optional AI/runtime phase:** DEFERRED.

See [`ROADMAP_CURRENT_CHECKPOINT.md`](ROADMAP_CURRENT_CHECKPOINT.md), [`PHASE5_SOURCE_COMPLETION_RECONCILIATION.md`](PHASE5_SOURCE_COMPLETION_RECONCILIATION.md), and [`PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md).

## Current architecture baseline

### GitHub and decision plane

- GitHub remains canonical for repository, SHA, issue, PR, review, rules and CI state.
- State-dependent mutations re-resolve authoritative GitHub state and fail closed on stale/ambiguous evidence.
- Merge never authorizes deployment, D1/Queue writes outside an exact separately-authorized contract, host work or credential changes.

### Webhook, Queue and D1

- GitHub webhook HMAC is verified over raw request bytes before payload identity is trusted.
- D1 stores bounded reconciliation, decision-audit/idempotency, notification, continuation, Later and Phase 5 observation state.
- Queue/DLQ delivery is a trigger mechanism, not canonical sequencing or authorization evidence.
- Duplicate/out-of-order messages must be harmless through durable lifecycle checks and idempotency.

### Phase 5 production visibility

The source path has advanced through the authenticated dormant runtime chain and complete Control-side activation preparation:

1. PR #577 — Ed25519 authenticated outer delivery over exact raw payload bytes.
2. PR #581 — replay-claim migration/helper.
3. PR #583 — authenticated ingestion composition.
4. PR #585 — bounded verification-key registry.
5. PR #587 — dormant-by-default Worker route/runtime source wiring.
6. PR #590 — production-visibility projection migration/store.
7. PR #592 — transactional replay + monotonic projection acceptance.
8. PR #594 — atomic authenticated ingestion/runtime composition.
9. **PR #596** — exact-main GET/SELECT-only production-readiness preflight.
10. PR #599 — predecessor migration/index classification.
11. PR #604 — fail-closed production D1 apply executor source.
12. PR #606 — dedicated D1 LIVE environment declaration.
13. PR #612 — fail-closed verification-key provisioning executor source.
14. #614–#616 — Worker activation candidate, executor and GET-only post-activation verifier source.
15. #618–#619 — sanitized RPi5 signer handoff and signed-observation read-only reconciliation source.
16. #620–#621 — production-visibility health UI and high-signal drift notification source.

The runtime remains dormant unless production evidence proves `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED` exactly `"true"`. Protected verification-key material remains outside repository/public evidence. None of the merged source proves that LIVE actions occurred.

For the detailed trust boundary use [`PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md), [`PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md`](PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md), and the final [`PHASE5_SOURCE_COMPLETION_RECONCILIATION.md`](PHASE5_SOURCE_COMPLETION_RECONCILIATION.md).

## Current gate model

### Read-only evidence checkpoint

Before selecting a mutation-bearing Phase 5 step, use a fresh exact-main GET/SELECT-only production preflight when current continuity requires production classification. This is a technical/read-only checkpoint, not an owner mutation gate.

A PASS means only that the observed baseline is coherent enough for separately authorized planning. A FAIL is diagnosis only. Neither permits production mutation (`READONLY_PREFLIGHT_EVIDENCE_ONLY`).

### Remaining conditional owner/LIVE gates

Fresh evidence selects the first actual remaining gate. The durable order is:

`fresh baseline → environment/credential prerequisite if missing → D1 apply if fresh baseline requires → verification-key provision if required → Worker activate → GET-only Worker verify → RPi5 signer/runtime under RPi5_main → read-only signed-observation reconciliation`.

Every mutation-bearing class has its own one-shot authority. There is no cross-class cascade, merge-to-deploy inheritance, historical authorization replay or automatic retry/rollback/cleanup after a consumed mutation fails.

## Explicit owner-gated work

Separately gated work includes:

- production Worker upload/deployment/promotion/configuration/route activation;
- production D1 migrations/data/schema writes;
- Queue mutation/replay/cleanup/configuration change;
- verification/private-key or other secret/credential provisioning/rotation/export;
- production ingest/binding mutation;
- GitHub App permission/repository-selection or repository settings/ruleset changes;
- Cloudflare Access/DNS/Tunnel/domain/binding/infrastructure mutation;
- RPi5 signer/runtime/host/root/systemd/Docker/network/helper mutation;
- rollback/cutover/destructive cleanup.

## Next safe step

There is no remaining queued Control source gap in the #613–#621 chain. Do not resume #614/#615 or invent another Phase 5 source lane merely to avoid a LIVE/external gate.

After the final source-completion reconciliation, the next technical step is a fresh exact-main read-only production baseline and prerequisite check. That evidence selects the first genuine owner/LIVE gate. Any production mutation still requires a separate explicit authorization bound to the current source, exact target and expected baseline. `SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN` remains the durable classification until current live facts are separately proven.

## Historical implementation chronology

Historical chronology is preserved in [`ROADMAP_HISTORY.md`](ROADMAP_HISTORY.md). Historical `CURRENT`, `NOT STARTED`, SHA, CI and runtime statements there are evidence from their time, not current authority.
