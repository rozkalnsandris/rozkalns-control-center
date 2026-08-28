# Phase 3 Later decision contract

Status: **source-only / dormant**.

This document defines the first bounded source contract for the operator-facing `Later` action. It does not activate a Worker route, D1 persistence, notification scheduling or React network mutation.

## Product meaning

`Later` is a deferral, not an approval or rejection. It must not authorize Merge, Needs changes, deploy, DB mutation, host mutation or any other privileged action.

For one exact normalized decision state, a future authenticated runtime may persist a Later deferral and suppress repeated operator attention while that material state remains unchanged. The old deferral must stop suppressing attention when materially relevant decision state changes. A future reminder policy may also deliberately release a deferral, but no reminder scheduler/policy is introduced in this slice.

## Source contract

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

## Security boundary

The fingerprint is deterministic bounded evidence, not an authorization token. A future runtime must still authenticate the actor, re-read authoritative decision state where required, persist deferral evidence durably and enforce its own idempotency/audit contract.

This source unit adds none of the following:

- Worker `Later` route;
- D1 migration/store;
- production D1 write;
- Queue/cron/reminder behavior;
- notification provider send;
- Cloudflare configuration;
- GitHub App permission or repository-selection change;
- React `/api/github/later` caller;
- production deployment.

## Future gates

The likely sequence after this source contract is reviewed/merged is deliberately split:

1. durable Later deferral persistence/idempotency source boundary;
2. authenticated fail-closed Worker route/runtime composition;
3. production D1 migration/apply if persistence requires a new schema;
4. separate production rollout/canary;
5. only after backend evidence, React `Later` network activation;
6. reminder/re-notification policy remains a separate product/source decision.

Every live mutation remains separately owner-gated. Merge authorization never authorizes any of those later steps.

## Current classification

- Production deploy: **NO**.
- Remote D1 migration/apply: **NO**.
- GitHub/Cloudflare permission growth: **NO**.
- Runtime/host mutation: **NO**.
- UI Later activation: **NO**.
