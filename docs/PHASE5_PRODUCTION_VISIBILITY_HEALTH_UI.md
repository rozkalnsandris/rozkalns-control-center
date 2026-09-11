# Phase 5 production-visibility health UI

Contract ID: `control-phase5-production-visibility-health-v1`

## Purpose

This contract turns already-sanitized Phase 5 production-visibility evidence into a bounded Control read model that can be rendered safely on the compact-phone dashboard.

It is read-only. It does not send observations, verify a signature again, mutate D1/Queues, deploy a Worker, invoke RPi5, or grant deploy/rollback/database/host authority.

## Status model

| Status | Meaning |
| --- | --- |
| `HEALTHY` | Fresh, structurally valid, in-sync evidence with healthy runtime, passing health, available rollback and no blocker codes. |
| `STALE` | Structurally valid evidence exists but is older than the five-minute visibility freshness ceiling. |
| `DRIFTED` | Fresh structurally valid evidence reports a production SHA different from the current main SHA. |
| `REJECTED` | The read-model evidence is malformed, contradictory, future-dated or belongs to a different project/repository identity. |
| `NOT_OBSERVED` | No sanitized production observation is present for the project in the current dashboard snapshot. |
| `UNKNOWN` | Evidence is fresh and structurally valid but runtime/health/rollback/blocker state is incomplete or unhealthy. |

The freshness boundary is inclusive: evidence exactly `300000 ms` old is still fresh; `300001 ms` is `STALE`.

`REJECTED` describes the Control read-model evidence. It does not claim that an RPi5 sender was cryptographically rejected.

## API projection

`/api/github/dashboard` adds `productionVisibilityHealth` for projects whose configured production adapter is `rpi5`.

The route derives this field only from the dashboard snapshot already returned by the bounded read path. It does not add a new database query or production capability.

Current source-level live dashboard composition still returns an empty `productionVisibility` collection. Therefore an RPi5-backed project is correctly surfaced as `NOT_OBSERVED` until a separately reviewed source lane wires accepted production-visibility evidence into that snapshot. The UI must not convert absence into `HEALTHY`.

Fixture/legacy snapshots that do not yet contain `productionVisibilityHealth` derive the same model client-side from their sanitized `productionVisibility` field so the rendering contract remains deterministic.

## Bounded evidence

When available, the UI may show only:

- project and repository identity;
- main SHA and production SHA;
- deploy-impact classification;
- runtime, health and rollback state;
- blocker codes/count;
- observation timestamp;
- derived drift and evidence age.

The health model intentionally contains no raw signed payload, signature, key ID, delivery ID, replay key, claim token, private/public verification key or credential material.

## UI safety

The project card uses text status plus the existing status pill semantics. Stale, rejected, not-observed and unknown states are explicitly non-authoritative.

Production evidence is evidence only. It never authorizes:

- deploy or Worker promotion;
- rollback;
- D1/database writes or migrations;
- Queue mutation;
- RPi5/host actions;
- Cloudflare infrastructure/configuration changes;
- secret or credential changes.

No new mutation button or action is introduced by this contract.

## Source readiness versus production state

Merged repository source proves the intended normalization, API projection and UI behavior. It does not prove that production D1 contains observations, that the Worker currently serves this exact source, that signer/runtime prerequisites are present, or that any production authorization exists.

Those remain separately evidenced and separately authorized.
