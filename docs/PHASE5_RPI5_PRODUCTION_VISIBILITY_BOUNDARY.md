# Phase 5 RPi5 production visibility boundary

Phase 5 may surface sanitized, read-only production evidence for managed projects whose `productionAdapter` is `rpi5`. This document defines the Control-side ingestion boundary only. It does not define or authorize a live RPi5 transport.

## Trust boundary

Control must not obtain production visibility by opening SSH, invoking sudo/helpers, reading protected host configuration, reading arbitrary filesystem/runtime data, querying a production database directly, or acquiring host credentials. RPi5-side production gates remain authoritative for host and production mutations.

A future producer may provide evidence only after its own repository has defined and reviewed a strict allowlist and sanitization process. Until that producer contract exists, the live Control dashboard must continue to report no live production evidence rather than synthesize it.

## Accepted consumer shape

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

Any additional field is rejected fail-closed. In particular, hostnames, addresses, filesystem paths, raw service output/logs, command output, SSH targets, credentials, tokens and secret-like fields are not part of this contract.

After the exact field allowlist is proven, the existing production-visibility normalizer still validates managed-project identity, the `rpi5` adapter, exact SHA syntax, bounded blocker codes, evidence freshness and contradictory runtime/health states. Drift is derived only from exact `mainSha`/`productionSha` equality.

## Non-authority

A normalized read model is evidence only. It does not authorize SSH/sudo/helper execution, deploy, rollback, database writes, Queue/Worker/Cloudflare changes, permission growth, runner changes or any other production mutation.

## Future transport gate

A later source slice may connect a reviewed producer to this consumer only after the producer repository exposes a documented sanitized payload with equivalent or tighter semantics. That transport must be reviewed separately and must remain read-only. Repository source and payload validation do not themselves prove current live production state.
