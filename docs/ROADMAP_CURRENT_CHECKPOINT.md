# Rozkalns Control — Current Roadmap Checkpoint

Last reconciled: **2026-09-09**.

Master issue #1 remains the canonical product/architecture contract, `docs/ROADMAP.md` remains the long-form roadmap, and issue #278 is the canonical operational handoff for changing live/current state. This checkpoint records durable architecture and gates only; it deliberately omits transient workflow-run IDs, deployment/version identifiers, secret values and one-shot authorization receipts.

Durable Phase 5 boundary markers:

- `SOURCE_READY_LIVE_UNPROVEN`
- `READONLY_PREFLIGHT_EVIDENCE_ONLY`
- `MERGE_NOT_DEPLOY_AUTHORITY`
- `EXACT_D1_MIGRATION_CEILING`

## Evidence boundary

- Repository source, tests and configuration prove intended behavior only.
- They do **not** independently prove active Worker version/traffic, applied D1 migrations, Queue state, protected binding/secret values, GitHub App grants, Cloudflare Access/routes, project capability activation, RPi5 signer/runtime state or successful observation delivery.
- Historical live canaries prove only their bounded completed actions. Their authority is consumed and never becomes standing permission.
- A successful read-only production preflight is a bounded observation at that time; it is not LIVE authorization and not durable proof of future state (`READONLY_PREFLIGHT_EVIDENCE_ONLY`).
- A source-controlled migration or `wrangler.jsonc` declaration is a deploy input, not remote-apply/deploy evidence.
- Merge never authorizes deployment or production mutation (`MERGE_NOT_DEPLOY_AUTHORITY`).

## Current phase classification

- **Phase 0 — repository/contracts:** complete.
- **Phase 1 — mobile-first decision UI:** complete.
- **Phase 2 — read-only GitHub/control-plane foundation:** live-read, GitHub App, webhook, D1 and Queue architecture established; current production facts remain separately evidenced.
- **Phase 3 — authenticated human decision actions:** complete for the bounded Merge, Needs changes and Later chain recorded by canonical #278; completed canaries create no standing mutation authority.
- **Phase 4 — notifications and deterministic continuation:** complete for the bounded Telegram/continuation chain recorded by canonical #278; historical receipts are terminal evidence only and must never be replayed.
- **Phase 5 — production visibility:** active. The authenticated observation ingestion/runtime chain, hardened GET/SELECT-only production-readiness preflight and source-only activation-gate contract are merged/source-defined. Current remote schema/key/activation/Worker/RPi5/delivery state remains freshly evidenced and/or separately gated (`SOURCE_READY_LIVE_UNPROVEN`).
- **Optional AI/runtime phase:** deferred.

## Durable current architecture

### Worker and browser surface

- React/Vite serves the mobile-first SPA through Cloudflare Workers Static Assets with `/api/*` routed through the Worker first.
- Static assets and Worker API responses share compatibility-tested security headers; sensitive/live responses are `Cache-Control: no-store`.
- Dashboard freshness and clock-skew checks remove mutation authority from stale, future or invalid evidence.
- Sanitized structured observability omits credentials, request bodies and protected configuration.

### GitHub authoritative reads and decision actions

- GitHub remains canonical for repositories, SHAs, issues, PRs, reviews, checks and policy evidence.
- The GitHub App runtime keeps JWT/private-key/installation-token handling inside the credential layer and exposes normalized evidence only.
- State-dependent Merge and Needs changes flows use unconditional fresh GitHub reads rather than cached authority.
- Access-authenticated routes exist for Needs changes, Merge and Later; project capability gates, expected-head binding and D1 audit/idempotency remain fail-closed.
- Canonical #278 records the bounded Phase 3 canary chain as completed historical evidence. Those actions do not authorize another invocation.

### Webhook, Queue and D1 reconciliation

- Webhook HMAC is verified over raw bytes before payload identity is trusted.
- D1 stores bounded reconciliation, decision-audit/idempotency, notification, continuation, Later and Phase 5 observation state.
- Queue messages are at-least-once triggers and may duplicate/reorder; correctness comes from durable state transitions, replay/idempotency handling and authoritative rereads.
- DLQ state remains bounded/observable; no implicit retry/requeue/delete authority exists.
- Source migrations remain deploy inputs only. Remote schema must be proven separately.

### Notifications and deterministic continuation

- Telegram transport, target configuration and notification dispatch Queue composition are present in source/configuration.
- Canonical #278 records the bounded Phase 4 delivery/resume chain as completed historical evidence.
- Source does not prove current Telegram credentials, target, Queue backlog, provider availability or Worker deployment.
- Continuation planning/reservation/persistence/recovery exists, but completion creates no blanket autonomous or reusable mutation authority.

### Phase 5 observation source path

The durable post-#599 path is:

```text
strictly sanitized RPi5 evidence
→ Ed25519-authenticated exact-byte delivery
→ exact keyId verification-key lookup
→ metadata/freshness + signature verification
→ durable replay claim
→ exact-byte parse + strict ten-field normalization
→ transactional replay + monotonic projection acceptance
→ dormant Worker route/runtime
```

Merged capability sequence:

- PR #568 — strict Control consumer;
- RPi5 PR #417 — strict producer sanitization/provenance source contract;
- PR #577 — Ed25519 authenticated outer delivery;
- PR #581 — replay-claim migration/helper;
- PR #583 — authenticated ingestion composition;
- PR #585 — bounded verification-key registry;
- PR #587 — dormant route/runtime wiring;
- PR #590 — production-visibility projection migration/store;
- PR #592 — atomic replay + monotonic projection acceptance migration/primitive;
- PR #594 — atomic authenticated runtime composition;
- PR #596 — GET/SELECT-only production-readiness preflight;
- PR #599 — hardened predecessor migration `0010_webhook_observability_hot_index.sql` and exact index `idx_webhook_deliveries_active_updated_delivery` classification for the D1 migration ceiling.

The route remains dormant unless `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED` is exactly `"true"`. Verification material is protected under `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS`; repository source does not provision its value. Source migrations `0010`–`0013` do not prove they are applied remotely.

The complete operator architecture and trust checklist are in [`PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md). The source-only future cutover/authorization contract is in [`PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md`](PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md) and `.github/phase5-rpi5-observation-activation-contract.json`.

## Merged readonly-preflight contract

The manual Phase 5 preflight is an observation mechanism, not an activation workflow.

It requires:

- workflow SHA equals authoritative `main` before and after evidence collection;
- successful exact-main push CI;
- one active Worker version at 100% normal traffic;
- `CONTROL_DB` binding and D1 resource identity match the expected production database;
- ingest is absent or explicit `false`, not active;
- verification-key binding is either absent or a protected secret binding type, without value inspection;
- predecessor migration `0010_webhook_observability_hot_index.sql` and `idx_webhook_deliveries_active_updated_delivery` are exactly consistent;
- migrations `0011`–`0013` are either all absent or all present;
- Phase 5 schema matches that migration classification;
- D1 queries are one statement beginning with `SELECT ` and provider metadata proves `changed_db=false`, `rows_written=0`, `changes=0`.

PASS means only `SAFE_FOR_SEPARATELY_AUTHORIZED_ACTIVATION_PLANNING`; FAIL is diagnosis evidence only. Neither outcome authorizes repair, apply, provisioning or activation (`READONLY_PREFLIGHT_EVIDENCE_ONLY`).

`EXACT_D1_MIGRATION_CEILING` is derived only from a fresh coherent hardened preflight. The source contract permits exactly three planning outcomes: all `0010`–`0013` pending, only `0011`–`0013` pending, or `NO_D1_APPLY_REQUIRED`. Any other predecessor/Phase 5 combination is STOP, not repair authority.

## Current gate model

### Read-only checkpoint

When canonical continuity calls for current production baseline classification, use the merged exact-main GET/SELECT-only preflight or equivalent reviewed read-only evidence. This is a technical checkpoint and must not be inflated into an owner mutation gate.

Do not treat a previous successful run as standing production truth. Re-read mutable GitHub/runtime state when a later decision depends on it.

### Mutation-bearing dependency order

If fresh evidence proves a mutation-bearing activation step is necessary, the planning order is:

1. fresh production baseline — read-only;
2. D1 migration apply if needed — separate LIVE authority naming the exact ordered migration ceiling from that fresh preflight;
3. verification-key provisioning if needed — separate secret/credential authority;
4. Worker configuration/deploy/activation — separate Cloudflare LIVE authority;
5. RPi5 signer/private-key/runtime delivery — separate RPi5 trust-boundary authority;
6. read-only/live evidence reconciliation — read-only unless another mutation is explicitly declared.

Each mutation class consumes only its own one-shot authorization at the first authorized mutation. An error, timeout, drift or ambiguity after mutation begins requires STOP; there is no implicit retry, rollback, cleanup, alternate path or cross-class cascade. No merged source, green preflight or historical canary collapses those gates.

## Phase 5 trust-boundary checkpoint

- No direct Control SSH/sudo/root/generic-helper path to RPi5.
- No protected-host filesystem/service/runtime/database inspection from Control.
- No verification/private key value in repo, logs, screenshots, public issues/PRs or evidence.
- Source merge is not proof of remote D1 apply, Worker deploy, binding setup or route activation.
- Observation evidence is not deploy/rollback/DB/Queue/credential/host authority.
- Historical Phase 3/4 canaries and consumed receipts are terminal and non-reusable.
- Unknown/stale/partial/mismatched evidence fails closed.

## Explicit owner/LIVE gates

The following remain separately gated:

- Worker upload/deployment/promotion/route activation;
- production D1 migrations/data/schema writes;
- Queue mutation/replay/configuration/cleanup;
- verification/private-key or other secret/credential provisioning/rotation/export;
- ingest or production binding mutation;
- live decision-route/canary invocation with write effects;
- GitHub App permission/repository-selection or repository settings/ruleset changes;
- Cloudflare Access/DNS/Tunnel/domain/infrastructure mutation;
- RPi5 signer/runtime/host/root/systemd/Docker/network/helper mutation;
- rollback/cutover/destructive cleanup.

## Current continuation rule

The old #574/#576 source lanes are completed history and are not current implementation pointers. Do not recreate them because older docs or issue bodies still mention them.

For present continuation, fresh-read canonical #278, current `main`, relevant current GitHub evidence, [`PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md) and [`PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md`](PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md). Select the next exact read-only or owner/LIVE gate from that fresh state. `SOURCE_READY_LIVE_UNPROVEN` remains the durable classification until live facts are freshly proven.
