# Phase 5 source-completion reconciliation

Contract ID: `control-phase5-source-completion-reconciliation-v1`.

This document is the durable Control-side reconciliation for the completed Phase 5 queued source chain through issues #613–#621. It records source readiness only. It does **not** prove current production state and it grants no LIVE authority.

Durable classification: `SOURCE_CHAIN_COMPLETE_LIVE_UNPROVEN`.

The pre-existing Phase 5 boundary markers remain mandatory:

- `SOURCE_READY_LIVE_UNPROVEN` — source can prove intended behavior, never current production facts;
- `READONLY_PREFLIGHT_EVIDENCE_ONLY` — read-only observations are evidence, not mutation permission;
- `MERGE_NOT_DEPLOY_AUTHORITY` — merge never becomes deploy, credential, database, Cloudflare or RPi5 authority.

For current mutable state, always fresh-read master #1, canonical handoff #278, current `main`, exact-main CI/policy checks and the focused live tracker. Historical workflow receipts and consumed authorizations are non-replayable.

## Reconciled source boundary

The queued source chain is complete for the Control-side Phase 5 preparation covered by #613–#621:

1. production D1 apply source executor: `.github/workflows/phase5-rpi5-observation-d1-live.yml`;
2. verification-key provisioning source executor: `.github/workflows/phase5-rpi5-observation-verification-key-live.yml`;
3. strict Worker activation candidate and exact-config boundary;
4. Worker activation source executor: `.github/workflows/phase5-rpi5-observation-worker-activate-live.yml`;
5. GET-only post-activation verifier: `.github/workflows/phase5-rpi5-observation-worker-post-activation-verify.yml`;
6. public-safe cross-repository signer handoff `PHASE5_RPI5_SIGNER_HANDOFF_V1` to `rozkalnsandris/RPi5_main`;
7. Control-side signed-observation reconciliation `control-phase5-rpi5-observation-reconciliation-v1`;
8. compact dashboard read model `control-phase5-production-visibility-health-v1`;
9. provider-neutral drift notification model `control-phase5-production-visibility-notification-v1`.

The Worker route remains a source contract until production evidence proves otherwise. The RPi5 signer/runtime remains owned by `RPi5_main`. The UI and notification contracts consume sanitized evidence only and introduce no remediation mutation.

There is **no new source lane** required merely to continue Phase 5 activation. Later source work is justified only by a newly discovered concrete defect or a separately selected future phase/maintenance item.

## First next step is read-only evidence, not an owner mutation gate

Before selecting any mutation-bearing Phase 5 action, obtain a fresh exact-main GET/SELECT-only preflight tied to the current source SHA and successful exact-main CI. Revalidate any required GitHub Environment/read credentials needed to obtain that evidence.

A preflight PASS can classify the current baseline and the exact conditional mutation needs. It does not authorize any mutation. A preflight FAIL is diagnosis only and must not trigger repair.

The fresh evidence determines whether the first genuine owner gate is an environment/credential prerequisite, a D1 apply, verification-key provisioning, Worker activation, or the external RPi5 lane. Do not select a later class from source history alone.

## Remaining owner/LIVE gates

The durable planning order is:

1. **Credential/environment prerequisites, if missing.** Any creation/change of protected GitHub Environment secrets, Cloudflare tokens, Worker write credentials or other protected configuration is its own explicit owner/LIVE gate. Secret values never belong in public commands, source, issues, logs or receipts.
2. **D1 apply only if the fresh preflight requires it.** The exact ordered migration ceiling must come from that one fresh baseline. If the baseline proves no D1 apply is required, this class is skipped rather than invoked.
3. **Verification-key provisioning only if the fresh preflight requires it.** This uses the dedicated source executor and its own one-shot authorization. The public `key_id` may be recorded; verification/private-key values may not.
4. **Worker activation after prerequisites are freshly proven.** This requires a separate owner/LIVE authorization bound to the exact current source, CI, fresh baseline, reviewed candidate and production Worker identity. The source executor must upload one candidate version, GET-verify it, then deploy only that exact verified version.
5. **RPi5 signer/runtime after Worker post-activation verification.** This is a separate `RPi5_main` trust-boundary authorization. Control has no SSH/sudo/root/generic-helper shortcut and no authority to provision the private signing key or mutate the host.

Each class is independent. Authorization for one class never authorizes the next.

## Read-only checkpoints

Read-only checkpoints are technical evidence steps, not owner mutation gates:

- fresh exact-main production preflight before the first LIVE mutation;
- read-only migration/schema verification after a D1 apply, if one is run;
- GET-only binding/deployment verification after verification-key provisioning, if run;
- GET verification of an uploaded Worker candidate before deployment;
- GET-only post-activation Worker verification;
- read-only signed-observation reconciliation after a separately authorized RPi5 signer/runtime delivery.

A read-only result never grants retry, repair, rollback, cleanup or another mutation class.

## Non-inheritance regression invariants

The following are hard invariants of this reconciliation:

- source merge grants no LIVE authority (`MERGE_NOT_DEPLOY_AUTHORITY`);
- read-only preflight grants no mutation authority (`READONLY_PREFLIGHT_EVIDENCE_ONLY`);
- no cross-class automatic cascade;
- no historical authorization replay;
- no protected value in public evidence;
- no automatic retry, rollback, cleanup or alternate mutation after a consumed authorization encounters error/ambiguity;
- Control does not own `RPI5_SIGNER_RUNTIME`;
- observation/health/notification evidence never becomes deploy, D1, Queue, credential, Cloudflare or host authority.

Unknown, stale, partial, contradictory or drifted evidence fails closed.

## Protected-data boundary

Public evidence may carry only bounded identities needed for exact binding, such as source SHA, CI/preflight run identity, Worker deployment/version identity, public `key_id`, migration classification, binding type/presence, sanitized project/repository identity and bounded health/reconciliation status.

It must never contain secret values, private keys, verification-key values, Cloudflare tokens, GitHub credentials, RPi5 host access details, protected filesystem/service data, raw signed payloads/signatures, replay claim tokens or privileged action tokens.

## Stop rule

After this source reconciliation is merged and exact-main checks pass, Control must stop creating speculative Phase 5 source work. The next continuation is selected only from fresh production/read-only evidence and current owner/external prerequisites.

If the next required action is mutation-bearing, stop at that exact separately authorized LIVE gate. If it belongs to `RPi5_main`, stop at that repository's current authorization contract. If no mutation is required, perform only the applicable read-only verification and continue evidence reconciliation.

This document does not authorize any workflow dispatch, secret/environment mutation, Worker deployment/configuration, D1/Queue write, Cloudflare mutation, RPi5 action or historical authorization replay.
