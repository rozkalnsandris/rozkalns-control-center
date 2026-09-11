# Rozkalns Control — Current Roadmap Checkpoint

Last reconciled: **2026-09-11**.

Master issue #1 remains the canonical product/architecture contract, `docs/ROADMAP.md` remains the current repository roadmap, and issue #278 is the canonical operational handoff for mutable live/current state. This checkpoint deliberately omits transient run IDs, deployment/version identifiers, secret values and one-shot receipts.

Durable Phase 5 boundary markers:

- `SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN`
- `SOURCE_READY_LIVE_UNPROVEN`
- `READONLY_PREFLIGHT_EVIDENCE_ONLY`
- `MERGE_NOT_DEPLOY_AUTHORITY`
- `EXACT_D1_MIGRATION_CEILING`

## Evidence boundary

- Repository source and configuration describe intended behavior; they do **not** prove current production state.
- Source does not independently prove active Worker traffic/version, remote D1 migration state, Queue state, protected bindings/secrets, Cloudflare routes/Access or RPi5 signer/runtime state.
- A successful read-only production preflight is bounded evidence at that time, never LIVE authorization.
- A source-controlled migration is a deploy input, not proof of remote apply.
- Merge never authorizes deployment or production mutation (`MERGE_NOT_DEPLOY_AUTHORITY`).

## Current phase classification

- Phases 0–1: complete.
- Phase 2: live-read/control-plane foundation established; mutable production facts are separately evidenced.
- Phase 3: bounded authenticated Merge / Needs changes / Later chain complete; historical canaries create no standing authority.
- Phase 4: bounded Telegram/continuation chain complete; historical receipts are terminal and non-replayable.
- **Phase 5:** Control-side queued source chain through #621 is complete; production state remains unproven by source (`SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN`).
- Optional AI/runtime phase: deferred.

## Durable current architecture

### Worker/browser and GitHub read surface

- React/Vite serves the SPA through Cloudflare Workers Static Assets; `GET /api/github/dashboard` is the bounded dashboard read surface.
- `POST /api/github/webhook` verifies raw-body HMAC before payload trust and schedules bounded reconciliation work through Queue-backed source paths.
- GitHub remains canonical for repository, SHA, PR, review, CI and policy evidence.
- Live/read responses retain `security headers`, `Cache-Control: no-store` where required, bounded timeout handling, rate-limit evidence and conditional GET behavior.
- State-dependent mutations must re-read authoritative evidence and fail closed.

### D1 and Queue

- `CONTROL_DB` is the production D1 binding contract for durable reconciliation/audit/continuation/Phase 5 observation state.
- Queue messages are at-least-once triggers, may duplicate or reorder, and never become authorization evidence.
- The Phase 5 migration ceiling includes predecessor `0010_webhook_observability_hot_index.sql` followed by `0011`–`0013`.
- Canonical #278 records the bounded Phase 5 production D1 apply as completed and its one-shot authorization as consumed/non-replayable. Fresh read-only D1 evidence must continue to match that completed state; contradiction is STOP/diagnosis, never replay authority.
- D1/Queue failure or ambiguity is an operational blocker, never permission to repair or mutate implicitly.

## Phase 5 reconciled source chain

Current source contains reviewed contracts for:

- authenticated sanitized RPi5 observation transport and atomic acceptance;
- exact-main GET/SELECT-only production preflight;
- production D1 apply executor;
- **PR #612 — verification-key provisioning executor**;
- Worker activation candidate and one-shot upload→GET-verify→deploy executor;
- GET-only post-activation Worker verifier;
- public-safe `PHASE5_RPI5_SIGNER_HANDOFF_V1` to `RPi5_main`;
- synthetic/public signed-observation compatibility vectors from #618;
- signed-observation read-only reconciliation;
- production-visibility health UI;
- high-signal visibility drift/recovery notification model.

The final durable reconciliation is [`PHASE5_SOURCE_COMPLETION_RECONCILIATION.md`](PHASE5_SOURCE_COMPLETION_RECONCILIATION.md). The detailed observation boundary remains [`PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md`](PHASE5_RPI5_PRODUCTION_VISIBILITY_BOUNDARY.md), and the hardened activation/cutover contract remains [`PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md`](PHASE5_RPI5_OBSERVATION_ACTIVATION_CONTRACT.md).

No current source statement proves the GitHub Environment credentials, Cloudflare tokens, protected verification registry, active Worker ingest state, current remote D1 schema, RPi5 private signing key/runtime or delivered observation state.

## Current gate model

### Technical/read-only checkpoint

Before any next mutation-bearing Phase 5 step, use a fresh exact-main GET/SELECT-only baseline when current continuity calls for production classification. It must bind the exact current source and successful exact-main CI and must preserve zero-mutation semantics.

PASS means `SAFE_FOR_SEPARATELY_AUTHORIZED_ACTIVATION_PLANNING`, not permission. FAIL is diagnosis only (`READONLY_PREFLIGHT_EVIDENCE_ONLY`).

Fresh D1 migration/schema evidence must agree with the already-completed Phase 5 apply. A mismatch does not recreate `D1_APPLY`; it requires STOP and fresh diagnosis/new scope.

### Remaining conditional owner/LIVE gates

Fresh evidence determines which forward gates are actually needed:

1. credential/environment prerequisites, if missing;
2. verification-key provision, if still required;
3. Worker activation after all prerequisites are freshly satisfied;
4. GET-only post-activation verification;
5. RPi5 signer/private-key/runtime delivery under the separate `RPi5_main` trust boundary;
6. read-only signed-observation reconciliation.

Read-only checkpoints are technical evidence steps and are not owner mutation gates. Every mutation-bearing class has separate one-shot owner authority. There is no cross-class cascade, historical authorization replay or merge-to-deploy inheritance.

## Trust-boundary checkpoint

- No direct Control SSH/sudo/root/generic-helper path to RPi5.
- No protected-host filesystem/service/runtime/database inspection from Control.
- No secret/private-key/verification-key value in repo, public issues, logs, screenshots or receipts.
- Source merge is not proof of Worker deploy, binding setup or route activation.
- The completed Phase 5 D1 apply is historical bounded evidence and may not be replayed from later contradictory reads.
- Observation/UI/notification evidence is not deploy, rollback, DB, Queue, credential or host authority.
- Unknown/stale/partial/mismatched evidence fails closed.
- After a mutation consumes authority, error/timeout/drift/ambiguity requires STOP; no automatic retry, rollback, cleanup or alternate mutation path.

## Current continuation rule

The #613–#621 queued source chain is complete. There is no current #614/#615 source implementation lane and no automatic post-#622 source queue.

After final source reconciliation, fresh-read canonical #278 and current production/read-only evidence. Require D1 evidence to remain consistent with the completed non-replayable apply, then select only the first genuine remaining owner/LIVE or external gate. If that gate belongs to `RPi5_main`, stop at its current repository-local authorization contract. Do not invent additional Control source work to avoid that boundary.

`SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN` remains the durable classification until live state is separately proven.
