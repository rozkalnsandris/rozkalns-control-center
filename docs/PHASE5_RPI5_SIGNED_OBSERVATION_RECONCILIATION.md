# Phase 5 signed-observation read-only reconciliation

Issue #619 defines the Control-side **read-only reconciliation** contract for one expected RPi5 signed observation after a separately authorized signer/runtime delivery. The implementation is [`src/integrations/cloudflare/rpi5-observation-reconciliation.ts`](../src/integrations/cloudflare/rpi5-observation-reconciliation.ts).

This source is evidence handling only. It does not send an observation, contact or mutate RPi5, deploy or reconfigure the Worker, write D1/Queue data, change Cloudflare settings, or read/write credentials, secret values, private keys or verification-key values. Source merge does not prove a live delivery and does not grant LIVE authority.

## What is reconciled

The caller supplies one exact public-safe expectation assembled from already reviewed evidence:

1. a normalized `PHASE5_RPI5_SIGNER_HANDOFF_V1` manifest;
2. the exact Control/Worker identity that the caller has freshly established for that handoff: Control source SHA, Worker deployment ID, Worker version ID, 100% traffic, ingest `PRESENT_TRUE`, and public `keyId`;
3. unsigned delivery metadata: observation transport version, public delivery UUID, canonical `sentAt`, and the same public `keyId`;
4. the exact ten-field sanitized production-visibility payload expected for the managed project.

The reconciler reuses the strict signer-handoff validator, strict sanitized production-visibility normalization and the existing five-minute observation freshness ceilings. The handoff must match the exact caller-supplied Control source, Worker deployment/version and public key identifier. The delivery must use the same key identifier and current transport version.

The Worker identity input is an **expected identity**, not a new Cloudflare reader. Before an operator relies on it, deployment/version/traffic/ingest facts must come from fresh GET-only evidence such as the merged Phase 5 post-activation verifier. Passing values into this function does not independently prove that those values are live.

## One bounded D1 snapshot

`D1Rpi5ObservationReconciliationReader` executes one SELECT-only snapshot keyed by:

- derived replay identity `${keyId}:${deliveryId}`;
- exact managed `projectId`;
- exact managed repository.

The SELECT joins the durable replay row to the current monotonic production-visibility projection. It never returns the replay `claim_token` value. SQL derives only a bounded boolean `atomic_acceptance` marker indicating whether the durable replay row carries the exact 32-lowercase-hex token shape written by the atomic acceptance store.

The reader rejects D1 write metadata, ambiguous multi-row reads, partial LEFT JOIN rows, malformed timestamps, malformed blocker JSON, identity mismatch and invalid stored visibility. No fallback query or repair path exists.

## Why the atomic marker matters

The merged runtime composition authenticates the exact raw payload bytes and delivery metadata before payload parsing. Valid normalized payloads then enter `D1Rpi5ObservationAcceptanceStore`, which atomically claims the replay identity and applies the monotonic projection update. A correctly signed but malformed payload follows the replay-only failure path instead and does not receive a new atomic acceptance token.

Reconciliation intentionally does **not** persist or re-read the signature, raw payload, public verification-key value or atomic claim-token value. Under the merged runtime contract, the derived atomic marker plus exact replay timing and an exact same-acceptance projection provide bounded durable evidence that the request crossed the authenticated, replay-safe, normalized atomic acceptance path.

This is source-contract evidence, not an independent cryptographic re-verification of historical bytes. Arbitrary D1 mutation outside the reviewed runtime would violate the trust boundary and is not made legitimate by this receipt.

## Same-acceptance projection binding

`ACCEPTED` requires all of the following:

- expected handoff, delivery and visibility evidence are canonical, non-future and within their five-minute freshness bounds;
- handoff and current expected Worker identity match exactly;
- exact replay row exists;
- replay expiry equals `sentAt + 300000ms` exactly;
- replay claim time is at or after `sentAt`, strictly before replay expiry, and not future-dated;
- derived `atomic_acceptance` is true;
- a projection exists for the exact project/repository;
- projection `storedAt` equals replay `claimedAt` exactly;
- project, repository, main SHA, production SHA, deploy-impact state, runtime, health, rollback, blocker codes and `observedAt` exactly match the expected sanitized visibility.

The `storedAt === claimedAt` requirement prevents a replay claim from being treated as proof for an unrelated earlier or later projection. If a valid atomic delivery was non-newer or the projection has since advanced, reconciliation reports drift rather than claiming the expected observation is the current accepted projection.

## Deterministic classifications

| Status | Meaning |
| --- | --- |
| `NOT_OBSERVED` | No durable row exists for the exact derived replay identity. |
| `STALE` | The expected handoff, delivery or visibility evidence has exceeded its bounded freshness window. No D1 read is needed. |
| `DRIFTED` | A validly shaped atomic replay claim exists, but the current projection is from a different acceptance time and/or differs from the exact expected visibility state. |
| `REJECTED` | Input/evidence is malformed, future/chronologically contradictory, D1 read fails, replay expiry/timing contradicts the expectation, the replay row is not an atomic-acceptance row, or the projection is missing/invalid. |
| `ACCEPTED` | Exact fresh expectation, exact atomic replay evidence and exact same-acceptance projection all agree. |

Reason codes are stable and bounded; raw provider errors and protected values are not echoed.

## Operator ladder

For a future separately authorized RPi5 signer/runtime delivery:

1. freshly prove exact current Control source and active Worker deployment/version with GET-only evidence;
2. normalize a fresh signer handoff bound to that exact identity and public `keyId`;
3. receive the separately produced public delivery metadata and expected sanitized observation identity without copying signature/key values into the operator receipt;
4. run this read-only reconciliation against the Phase 5 D1 binding;
5. treat only `ACCEPTED` as evidence that this exact bounded expectation agrees with the durable atomic acceptance state;
6. treat every other status as evidence for diagnosis/next planning only, never as permission to retry, repair, deploy, mutate D1/Queue/Cloudflare, change credentials, or access RPi5.

A later production invocation still requires whatever current GET-only/preflight and owner gates govern that operation. This merged source alone does not establish production schema presence, Worker activation, signer/runtime deployment or a successful live observation.

## Receipt boundary

The public-safe receipt contains only:

- stable reconciliation contract ID, status and bounded reason codes;
- expected Control SHA and Worker deployment/version identity;
- public `keyId`, delivery UUID/timestamps and derived replay identity/expiry;
- normalized sanitized production-visibility state;
- observed replay timestamps plus the boolean atomic marker;
- observed normalized projection and `storedAt`, when present;
- explicit `evidenceOnly=true` and all mutation-authority flags false.

It contains no signature, raw payload, replay claim-token value, public-key value, private-key value, credential/token/secret value, host identity, filesystem/service detail, mutation command or rollback instruction.

## Regression coverage

`tests/rpi5-observation-reconciliation.test.ts` covers:

- exact fresh `ACCEPTED` reconciliation;
- exact replay miss -> `NOT_OBSERVED`;
- freshness, future-time and chronology boundaries;
- exact handoff/Control/Worker/key binding;
- replay-only, wrong-expiry, invalid-claim-time and missing-projection rejection;
- projection supersession and state mismatch -> `DRIFTED`;
- bounded receipt safety markers;
- single SELECT D1 snapshot and boolean-only atomic marker;
- replay-without-projection and malformed/ambiguous D1 failure behavior;
- reader exceptions/malformed adapter output -> fail-closed `REJECTED`.
