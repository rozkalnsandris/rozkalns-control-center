# Phase 4 Telegram D1 + post-Gate-A LIVE-scope read-only evidence

This document defines the source-only evidence step after the Phase 4 Telegram Gate A incident correction. It does not authorize or perform production mutation.

## Why this workflow exists

The existing `phase4-telegram-activation-readonly-preflight.yml` intentionally remains a literal GET-only workflow. Its successful post-incident run can prove the current Worker deployment, notification bindings, Queue identity and Worker consumer, but it deliberately reports `D1_NOTIFICATION_MIGRATIONS=NOT_PROVEN_GET_ONLY`.

D1 schema state cannot be truthfully inferred from repository migration files or historical acceptance. The separate `phase4-telegram-d1-live-scope-readonly.yml` workflow closes only that evidence gap while preserving the original GET-only contract.

## Read-only D1 boundary

The workflow uses the existing `production-readonly-reconcile` environment and the dedicated `CLOUDFLARE_D1_READ_TOKEN`. D1 verification uses Cloudflare's D1 query endpoint only for one-statement `SELECT` queries.

Every query must satisfy all of these guards before its result is trusted:

- the SQL starts with `SELECT`;
- no second statement is allowed;
- the Cloudflare response is successful;
- `changed_db` is false;
- `rows_written` is zero;
- `changes` is zero.

A POST transport to the D1 query endpoint is therefore not treated as write authority: the SQL itself is restricted to SELECT and the returned D1 metadata must prove zero mutation. Any ambiguity fails closed.

## Notification migration evidence

Fresh production evidence must prove these four migration records occur exactly once and in migration-history order:

1. `0003_notification_transitions.sql`
2. `0004_notification_delivery_intents.sql`
3. `0005_notification_delivery_attempts.sql`
4. `0006_notification_delivery_dispatch_claims.sql`

The workflow also requires these tables to exist:

- `notification_transitions`
- `notification_delivery_intents`
- `notification_delivery_attempts`
- `notification_delivery_dispatch_claims`

Row counts are emitted only as bounded operational evidence. A non-zero count is not itself permission to deliver or backfill notifications.

## Post-Gate-A production state

The workflow independently revalidates:

- exact current `main` and exact-main successful push CI;
- one active Worker version at 100% traffic;
- the reviewed notification activation bindings, target, retry policy and protected Telegram secret bindings;
- the exact dispatch Queue and Worker consumer policy;
- nullable `script_name` as optional attestation, with every non-null value required to equal `rozkalns-control`;
- Queue delivery remains paused;
- best-effort point-in-time Queue backlog count, bytes and oldest-message timestamp;
- final main, Worker deployment/version and Queue pause state have not drifted during the read-only run.

Queue metrics are evidence, not a stable promise. Any future resume decision must read the paused state and backlog again immediately before mutation.

## Gate A is terminal

Failed Gate A run `33804977962` consumed its one-shot authorization. It must never be rerun or reconstructed as a retry. The post-Gate-A scope therefore freezes all already-completed Gate A mutation categories at zero:

- D1 migration/write: 0
- Queue create: 0
- Queue pause: 0
- Queue consumer create/change: 0
- Telegram secret binding change: 0
- Worker version upload: 0
- Worker deployment write/promotion: 0
- direct Telegram API request: 0

No rollback, cleanup, Queue purge/delete or alternate deployment path is implied.

## Candidate Gate B boundary

If the read-only workflow passes, the only candidate production mutation category exposed for later review is at most one dispatch Queue delivery resume. That is a scope candidate, not authorization.

The workflow deliberately records:

- `PROVIDER_DELIVERY_RESUME_MUTATION_MAX=1`
- `DIRECT_TELEGRAM_API_REQUEST_MAX=0`
- `PROVIDER_RESUME_PRECONDITION=FRESH_QUEUE_PAUSED_AND_BACKLOG_RECHECK_REQUIRED`
- `GATE_B_EXECUTOR=SOURCE_PRESENT_SEPARATE_LIVE_AUTHORIZATION_REQUIRED`
- `LIVE_AUTHORIZATION=NOT_GRANTED`

If the observed backlog is non-zero, the receipt classifies Gate B as `REPLAY_SAFE_DURABLE_INTENT_DRAIN_READY`; otherwise it remains `GATE_B_LIVE_AUTHORIZATION_REQUIRED`. Neither result permits Queue resume.

The source-present Gate B executor defines the fail-closed `REPLAY_SAFE_DURABLE_INTENT_DRAIN` policy and the consequences of resuming Queue delivery. A fresh exact-main CI plus a fresh successful read-only run on that same merged SHA are still required before the owner may consider the separate exact Gate B LIVE authorization.

## Explicit exclusions

This evidence workflow must not:

- dispatch Gate A or any Gate B mutation;
- apply D1 migrations or write D1 rows;
- create, pause, resume, purge or delete a Queue;
- create/change a Queue consumer;
- upload/deploy/promote a Worker version;
- create/rotate/export Telegram secrets;
- call the Telegram provider API;
- change Cloudflare Access, DNS, routes, bindings or permissions;
- perform rollback or cleanup.

Merge of this source evidence path is not LIVE authorization.
