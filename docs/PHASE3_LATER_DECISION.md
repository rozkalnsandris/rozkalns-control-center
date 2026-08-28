# Phase 3 Later decision contract

Status: **source-only / dormant persistence staged**.

This document defines the bounded source contract for the operator-facing `Later` action and its dormant D1 persistence/idempotency adapter. It does not activate a Worker route, apply a production D1 migration, schedule notifications or connect React to a network mutation.

## Product meaning

`Later` is a deferral, not an approval or rejection. It must not authorize Merge, Needs changes, deploy, DB mutation, host mutation or any other privileged action.

For one exact normalized decision state, a future authenticated runtime may persist a Later deferral and suppress repeated operator attention while that material state remains unchanged. The old deferral must stop suppressing attention when materially relevant decision state changes. A future reminder policy may also deliberately release a deferral, but no reminder scheduler/policy is introduced in this source slice.

## Pure decision contract

`src/shared/later-decision.ts` provides two pure operations:

1. `createLaterDeferral(...)`
   - requires the current normalized decision to explicitly allow `LATER`;
   - validates bounded decision identity and exact SHA evidence;
   - records only schema version, decision/project identity, issue/PR numbers, one deterministic material-state fingerprint and exact UTC deferral time;
   - performs no I/O.

2. `evaluateLaterDeferral(...)`
   - validates the prior evidence and the fresh normalized decision;
   - fails closed if decision/project identity changes;
   - returns `DEFERRED_UNCHANGED` when only non-material reconciliation/display metadata changed;
   - returns `RELEASE_MATERIAL_CHANGE` when material decision authority changed.

Material state currently includes:

- decision + project identity;
- workflow state;
- issue/PR numeric identity;
- CI and review state;
- deploy impact;
- changed-file count;
- expected/current PR head SHA;
- main SHA;
- human-action reason;
- normalized allowed-action set.

The following are intentionally not material for deferral continuity:

- `lastReconciledAt`;
- issue/PR display titles;
- PR URL;
- ordering of the same allowed-action set.

This means a normal reconciliation timestamp refresh or harmless title/link presentation change does not re-notify the operator, while source/head/CI/review/reason/action-authority drift releases the old deferral.

## Dormant persistence contract

`src/shared/later-deferral-store.ts` and `src/integrations/cloudflare/d1-later-deferral-store.ts` add the source-only durable boundary. `migrations/0009_later_deferrals.sql` defines the corresponding D1 schema but does not apply itself anywhere.

The store persists one active deferral per `decision_id` with:

- schema version;
- decision/project identity;
- nullable issue/PR identity;
- material-state fingerprint;
- original deferral timestamp;
- bounded actor subject and optional actor email for future authenticated audit evidence.

Actor data is audit evidence only. It is never an authorization token and the D1 adapter performs no authentication.

### Claim/idempotency

A first `claim(...)` inserts exactly one row with a prepared/bound statement and verifies D1 `meta.changes`:

- `CLAIMED` — one new row was inserted;
- `REPLAY` — the same decision/project/material fingerprint already exists; the original persisted timestamp/evidence is preserved;
- `CONFLICT` — the decision identity is already deferred at a different material fingerprint.

A same-fingerprint row whose separately stored issue/PR identity does not match fails closed rather than being accepted as a replay.

### Explicit material-state replacement

A future authenticated caller that deliberately accepts `Later` again after material state changed may call `replace(...)` with both:

- the exact expected previous fingerprint; and
- fresh Later evidence with a different fingerprint.

The D1 update is compare-and-swap scoped by decision/project identity plus the expected previous fingerprint:

- `REPLACED` — exactly one expected row changed;
- `REPLAY` — an equivalent new fingerprint is already persisted, such as after a concurrent equivalent replacement;
- `CONFLICT` — the row is absent or no longer matches the expected/new state.

There is no blind overwrite and a replacement that supplies the same old/new fingerprint is rejected.

## Cloudflare D1 implementation contract

The adapter follows the repository's existing D1 pattern and current Cloudflare D1 Worker API contract:

- SQL parameters are passed through `prepare(...).bind(...)` rather than interpolated into SQL;
- write results must report `success=true`;
- `meta.changes` must be exactly `0` or `1` for claim/CAS operations;
- conflict rows are read back and revalidated before replay/conflict classification;
- migration ordering is source-controlled and sequential.

The migration deliberately excludes Access JWTs, GitHub tokens, private keys, secrets, raw request bodies and webhook payloads.

## Security boundary

The material-state fingerprint is deterministic bounded evidence, not an authorization token. A future runtime must still cryptographically authenticate the actor through the reviewed Cloudflare Access boundary, obtain fresh normalized decision state, require `LATER` authority and only then call this store.

This source unit adds none of the following:

- Worker `/api/github/later` route/runtime;
- production D1 migration/apply;
- Queue/cron/reminder behavior;
- notification provider send;
- Cloudflare Access/DNS/Tunnel mutation;
- GitHub App permission or repository-selection change;
- React `/api/github/later` caller;
- production deployment.

## Future gates

The sequence remains deliberately split:

1. pure Later decision contract — **merged**;
2. durable Later D1 persistence/idempotency source boundary — **current source slice**;
3. authenticated fail-closed Worker route/runtime composition — separate source slice;
4. remote `0009_later_deferrals.sql` D1 migration apply — separate explicit owner-gated live mutation before live persistence can operate;
5. separate production Worker rollout/canary;
6. only after backend evidence, React `Later` network activation;
7. reminder/re-notification policy remains a separate product/source decision.

Every live mutation remains separately owner-gated. Merge authorization never authorizes D1 apply, deployment or any later activation.

## Current classification

- Production deploy: **NO** for this dormant adapter/migration source slice.
- Remote D1 migration/apply: **NOT DONE**; `0009` will be required before future live Later persistence runtime use.
- GitHub/Cloudflare permission growth: **NO**.
- Runtime/host mutation: **NO**.
- UI Later activation: **NO**.
