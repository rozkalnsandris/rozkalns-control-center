# Phase 5 RPi5 production visibility boundary

Phase 5 may surface sanitized, read-only production evidence for managed projects whose `productionAdapter` is `rpi5`. This document defines the Control-side ingestion and authenticated-delivery source boundary only. It does not define or authorize a live RPi5 transport, key provisioning, replay persistence or runtime wiring.

## Trust boundary

Control must not obtain production visibility by opening SSH, invoking sudo/helpers, reading protected host configuration, reading arbitrary filesystem/runtime data, querying a production database directly, or acquiring host credentials. RPi5-side production gates remain authoritative for host and production mutations.

The canonical `RPi5_main` producer now defines an equivalent-or-tighter strict sanitization/provenance source contract for this payload. That producer source acquires no production evidence and grants no host/runtime authority. This Control slice therefore remains source-independent from current RPi5 host/runtime state.

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

## Authenticated delivery source contract

`src/shared/rpi5-observation-transport.ts` defines an outer transport envelope without changing the ten-field sanitized payload. The envelope is strict and contains only:

- `version`
- `deliveryId`
- `sentAt`
- `keyId`
- `signature`

The source contract is one-way RPi5 -> Control and verifier-only on the Control side. RPi5 signs with an Ed25519 private key; Control verification requires only the corresponding public key. No credential usable to log in to or query RPi5 is part of this contract.

The signing input is domain-separated and binds the transport version, UUIDv4 delivery identity, canonical send timestamp, key identifier, payload byte length and the exact raw payload bytes. The payload is not parsed or reserialized before signature verification. Delivery metadata older than five minutes or from the future fails closed, as do malformed/extra metadata and invalid signatures.

Signature verification returns a stable `replayKey` and expiry. It does **not** by itself prove delivery uniqueness. A later runtime slice must atomically claim that replay identity in a separately reviewed durable replay store before the payload may be trusted, then parse the exact signed bytes and pass the resulting object to `normalizeSanitizedProductionVisibility`. This repository slice introduces no replay-store binding or production write.

## Source-only state

This boundary is intentionally not imported by the Worker entrypoint and introduces no Wrangler binding. It does not provision/generate/rotate keys, expose an HTTP route, persist replay state, acquire RPi5 evidence or connect any network path. Those are later, separately reviewed gates.

## Non-authority

A valid signature and normalized read model are evidence only. They do not authorize SSH/sudo/helper execution, deploy, rollback, database writes, Queue/Worker/Cloudflare changes, permission growth, runner changes or any other production mutation. Repository source and payload validation do not themselves prove current live production state.

## Later transport/runtime gate

A later slice may wire the reviewed producer and this verifier only after fresh canonical continuity confirms the exact transport, public-key provisioning method, replay-store semantics, endpoint/binding scope and protected-host acquisition boundary. GET-only production preflight may then collect read-only evidence if it is the current gate. Any key/secret provisioning, D1/Queue write, Cloudflare mutation or RPi5 host/runtime/network mutation remains separately owner-authorized.
