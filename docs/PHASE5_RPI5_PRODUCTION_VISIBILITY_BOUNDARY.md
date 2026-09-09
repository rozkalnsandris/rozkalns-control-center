# Phase 5 RPi5 production visibility — observation operator contract

Phase 5 may surface sanitized, read-only production evidence for managed projects whose `productionAdapter` is `rpi5`. This document is the durable Control-side operator contract for the merged authenticated observation source path and its GET/SELECT-only production-readiness preflight.

Stable boundary markers:

- `SOURCE_READY_LIVE_UNPROVEN` — repository source can prove the intended observation path, but it does not prove current Worker, D1, binding, key, RPi5 or delivery state.
- `READONLY_PREFLIGHT_EVIDENCE_ONLY` — a preflight PASS/FAIL is classification evidence only; it grants no mutation authority.
- `MERGE_NOT_DEPLOY_AUTHORITY` — source merge never authorizes Worker deployment, D1/Queue writes, key provisioning or RPi5 runtime work.

Master issue #1 and canonical handoff #278 remain authoritative for product and mutable operational continuity. Current runtime facts must always be freshly re-read rather than copied into this durable document.

The source-only activation/cutover rules derived from this boundary are defined in [`PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md`](PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md) and `.github/phase5-rpi5-observation-activation-contract.json`. Those files describe future gates; they grant no LIVE authority.

## Merged source architecture

The current source-level path is intentionally one-way and fail-closed:

```text
strictly sanitized RPi5 evidence
→ Ed25519-authenticated outer delivery over exact raw payload bytes
→ exact keyId lookup in the bounded verification-key registry
→ delivery metadata/freshness and signature verification
→ durable replay claim
→ parse the exact signed payload bytes
→ strict ten-field production-visibility normalization
→ transactional replay + monotonic projection acceptance
→ dormant Worker route/runtime
```

Durable source progression:

- PR #568 — strict ten-field Control consumer for already-sanitized RPi5 evidence;
- RPi5 PR #417 — equivalent-or-tighter producer sanitization/provenance source contract;
- PR #577 — Ed25519 outer delivery contract binding metadata and exact raw payload bytes;
- PR #581 — source migration `0011_rpi5_observation_replay_claims.sql` and durable replay-claim helper;
- PR #583 — authenticated ingestion composition from metadata/signature through replay claim and strict normalization;
- PR #585 — strict verification-key registry with exact `keyId` lookup and no fallback;
- PR #587 — dormant-by-default Worker route/runtime source wiring;
- PR #590 — source migration `0012_rpi5_production_visibility_projection.sql` and bounded projection store;
- PR #592 — source migration `0013_rpi5_observation_atomic_acceptance.sql` and transactional replay + monotonic projection acceptance;
- PR #594 — atomic authenticated ingestion/runtime composition through the dormant Worker route;
- PR #596 — merged GET/SELECT-only production-readiness preflight;
- PR #599 — hardened the preflight to classify predecessor migration `0010_webhook_observability_hot_index.sql` and exact partial index `idx_webhook_deliveries_active_updated_delivery` before deriving any D1 migration ceiling.

The route remains fail-closed and dormant unless `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED` is exactly `"true"`. Repository configuration does not provision that activation flag or a `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS` value. Source migrations `0010`–`0013` are deploy inputs only and do not prove remote application.

## Sanitized consumer boundary

`normalizeSanitizedProductionVisibility(input, nowInput)` accepts `unknown` data and requires exactly these top-level fields:

- `projectId`
- `repository`
- `mainSha`
- `productionSha`
- `deployImpact`
- `runtime`
- `health`
- `rollback`
- `blockerCodes`
- `observedAt`

Any additional field is rejected fail-closed. Hostnames, addresses, filesystem paths, raw service output/logs, command output, SSH targets, credentials, tokens and secret-like fields are not part of this contract.

After the exact field allowlist is proven, the normalizer still validates managed-project identity, the `rpi5` adapter, exact SHA syntax, bounded blocker codes, evidence freshness and contradictory runtime/health states. Drift is derived only from exact `mainSha`/`productionSha` equality.

## Authenticated delivery boundary

`src/shared/rpi5-observation-transport.ts` defines the strict outer envelope without changing the ten-field sanitized payload. Delivery metadata contains only `version`, `deliveryId`, `sentAt`, `keyId` and `signature`.

RPi5 signs with Ed25519; Control is verifier-only and requires only the matching public verification material selected by exact `keyId`. The signing input is domain-separated and binds transport version, delivery UUID, canonical send time, key identifier, payload byte length and the exact raw payload bytes. Payload bytes are not parsed or reserialized before signature verification.

Metadata outside the allowed freshness window, malformed/extra metadata, unknown keys, invalid signatures and contradictory evidence fail closed. Neither a valid signature nor a successful normalization grants production authority.

## Durable replay and atomic projection boundary

A valid signature yields a replay identity, but signature validity alone is not uniqueness. The merged source path durably claims replay identity before trusting parsed payload data and uses the source-controlled Phase 5 D1 primitives to prevent reuse.

Projection acceptance is monotonic and transactional with replay acceptance: older/contradictory observation state must not overwrite a newer accepted projection. These source contracts rely on migrations `0011`–`0013`; their presence in Git proves only the intended schema/input, not that production D1 has applied them.

## GET/SELECT-only production-readiness preflight

The merged workflow `.github/workflows/phase5-rpi5-observation-readonly-preflight.yml` is a manually dispatched classifier. Running it is a read-only checkpoint, not a LIVE authorization.

It must fail closed unless all of the following are true:

1. the workflow runs from `main` and its `GITHUB_SHA` still equals the authoritative branch head;
2. an exact-main `CI` push run for that SHA is completed successfully;
3. Cloudflare Workers inventory is obtained with GET-only APIs;
4. the active Worker deployment is exactly one version at 100% traffic;
5. the active `CONTROL_DB` D1 binding matches the repository's expected production D1 identity;
6. `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED` is absent or explicit plain-text `false`; explicit `true` fails with `INGEST_ALREADY_ACTIVE`;
7. `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS`, if present, is only classified by binding name/type as protected secret material; its value is never read, parsed or exported;
8. D1 resource identity matches the expected database;
9. D1 SQL is one statement beginning with `SELECT ` and every query proves `changed_db=false`, `rows_written=0` and `changes=0`;
10. predecessor migration `0010_webhook_observability_hot_index.sql` and `idx_webhook_deliveries_active_updated_delivery` agree exactly, while migrations `0011`–`0013` and Phase 5 schema also agree exactly;
11. `main` still equals the workflow SHA after evidence collection.

The D1 API uses its query endpoint, which is HTTP POST, but the workflow wrapper admits only single-statement `SELECT` SQL and rejects any provider response that reports a mutation. This does not create D1 write authority.

The hardened public-safe fields include `D1_0010_MIGRATION`, `D1_0010_INDEX`, `D1_PHASE5_MIGRATIONS` and `D1_PHASE5_SCHEMA`. Exact D1 apply scope may be derived only from one coherent combination defined by the source-only activation contract; unknown, partial or contradictory evidence is STOP, never repair authority.

## Preflight classification matrix

| Observation | Classification | Operator meaning | Mutation authority |
| --- | --- | --- | --- |
| `0010` absent and exact predecessor index absent | `ABSENT` + `ABSENT_CONSISTENT` | Any later D1 apply ceiling must include `0010` before Phase 5 migrations | None |
| `0010` present and exact predecessor index valid | `PRESENT` + `PRESENT_VALID` | Predecessor state is coherent; later ceiling may begin at `0011` if Phase 5 remains absent | None |
| `0010` history/index contradict each other | STOP | Exact migration ceiling cannot be trusted | None |
| `0011`–`0013` all absent and Phase 5 tables absent | `ABSENT` + `ABSENT_CONSISTENT` | Safe pre-provisioning schema baseline; later migration application may be planned only with the predecessor classification | None |
| `0011`–`0013` all present and required tables/columns probe successfully | `PRESENT` + `PRESENT_VALID` | Remote schema is internally consistent with the merged Phase 5 source contract | None |
| Partial, duplicate or contradictory migration history | STOP | Diagnosis evidence; history cannot be trusted as a coherent baseline | None |
| Tables/columns contradict migration history | STOP | Diagnosis evidence; schema/history do not match | None |
| Ingest flag is already `"true"` | `INGEST_ALREADY_ACTIVE` STOP | Expected dormant baseline is violated; do not adapt or disable it automatically | None |
| Ingest binding is malformed/ambiguous | STOP | Activation state is not safely classifiable | None |
| Verification-key binding is missing | `ABSENT` | Allowed pre-provisioning state | None |
| Verification-key binding is a protected secret type | `PRESENT_PROTECTED` | Presence/type only; value remains opaque | None |
| Verification-key binding is exposed or wrong type | STOP | Protected configuration boundary is violated/ambiguous | None |
| Worker deployment, version, `CONTROL_DB` binding or D1 resource identity mismatches | STOP | Production baseline is not the expected target | None |
| All checks pass | `BASELINE=SAFE_FOR_SEPARATELY_AUTHORIZED_ACTIVATION_PLANNING` | Evidence can inform the next plan only | None |

A FAIL must never be “fixed” by an unapproved production mutation. A PASS must never be interpreted as permission to mutate production.

## Future activation dependency order

When mutable operational continuity says Phase 5 activation should proceed, use the following dependency order only as a planning graph. Every mutation-bearing step requires its own exact owner/LIVE authority under the current governing contract.

1. **Fresh production baseline** — GET/SELECT-only evidence tied to exact current source and target. Read-only.
2. **D1 migration apply, if required** — production D1 mutation; separate LIVE gate, scoped to the exact ordered migration ceiling derived from the fresh hardened preflight.
3. **Verification-key provisioning, if required** — secret/credential mutation; separate LIVE gate. Never put key material in Git, D1 evidence, logs or public receipts.
4. **Worker configuration/deployment/activation** — Cloudflare production mutation; separate LIVE gate with exact SHA/target/baseline.
5. **RPi5 signer/private-key/runtime delivery** — RPi5 trust-boundary mutation; separately authorized under the owning RPi5 contract.
6. **Observation reconciliation** — GET-only/read-only evidence may verify the resulting state; any additional mutation remains separately gated.

Do not collapse these steps merely because source code is merged or a preflight is green. The exact one-shot semantics and future owner command shapes are in [`PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md`](PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md).

## Trust-boundary checklist

Before treating any Phase 5 observation work as eligible, require all of the following:

- [ ] No direct Control SSH, sudo, root, generic helper or privileged host-login path.
- [ ] No Control-side protected-host filesystem, service, runtime or production-database inspection.
- [ ] No verification-key/private-key value in repository source, public issues/PRs, fixtures, logs, screenshots or bounded evidence.
- [ ] A source-controlled migration is never represented as proof of remote migration application.
- [ ] A source merge is never represented as proof of Worker deployment, binding configuration or route activation.
- [ ] Observation evidence is never treated as deploy, rollback, DB/data, Queue, credential or host authority.
- [ ] Merge remains distinct from deploy/LIVE authority (`MERGE_NOT_DEPLOY_AUTHORITY`).
- [ ] Historical Phase 3/4 canaries and consumed authorization receipts are never replayed.
- [ ] Unknown, stale, partial, mismatched or contradictory evidence fails closed.

## Non-authority and current-state rule

Repository source/configuration can prove the intended observation contract. It cannot independently prove the active Worker version/traffic, remote D1 migration/schema state, binding/secret values, ingest activation, verification-key registry content, RPi5 signer/runtime state or successful live observation delivery.

Current production facts belong in fresh GitHub/runtime evidence, not this file. Even when a read-only preflight has run successfully, its result is a bounded observation at that time; it does not become standing authority or durable proof of future state.

See [`../README.md`](../README.md), [`ROADMAP.md`](ROADMAP.md), [`ROADMAP_CURRENT_CHECKPOINT.md`](ROADMAP_CURRENT_CHECKPOINT.md) and [`PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md`](PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md) for the navigational/current phase and future activation-gate view.
