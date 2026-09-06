# Architecture

This document describes the current durable source architecture and trust boundaries for Rozkalns Control. Master issue #1 remains authoritative for product scope; issue #278 is authoritative for mutable operational continuity. Repository source/configuration is evidence of intended implementation only and must not be treated as proof of current deployment, bindings, secrets, provider state or RPi5 runtime state.

## Goals

- mobile-first approval/status surface;
- one coherent view across managed GitHub projects;
- deterministic, auditable human actions;
- GitHub remains engineering source of truth;
- production remains behind existing RPi5 trust boundaries;
- no AI API requirement for the MVP.

## Current high-level source architecture

```text
Android / desktop browser
        |
        v
Cloudflare Access
        |
        v
Rozkalns Control Worker + React SPA
        |
        +--> D1: reconciliation, decisions, notifications, continuation, deferrals
        +--> Queue/DLQ: GitHub reconciliation + notification dispatch triggers
        +--> Telegram transport: source/configured notification provider boundary
        |
        v
Dedicated Rozkalns Control GitHub App
        |
        v
GitHub repositories / issues / PRs / reviews / Actions

RPi5 production plane remains separate and authoritative.
Future Phase 5 flow: RPi5 strict sanitized producer -> read-only transport -> Control strict consumer.
```

The diagram is a source architecture, not a production-state assertion. In particular it does not prove that the currently deployed Worker has every source binding/secret, that a D1 migration is applied, that Queue/provider state is healthy, or that Phase 5 producer transport exists.

## Frontend

The implemented source stack is:

- React;
- TypeScript;
- Vite;
- Cloudflare Vite plugin;
- Workers Static Assets;
- Android-first responsive UI.

The browser consumes normalized models only. It never receives GitHub App private keys, Telegram bot credentials or other privileged machine credentials. Stale/future/invalid evidence loses mutation authority in the UI.

## Worker API

The Worker is the trusted public control-plane API boundary. Current source responsibilities include:

- cryptographic Cloudflare Access validation for protected human routes;
- GitHub webhook HMAC validation over raw bytes;
- bounded normalized GitHub read composition;
- live GitHub re-resolution before state-dependent mutations;
- capability/state-transition enforcement;
- bounded decision/audit/idempotency persistence;
- Queue-backed reconciliation and notification-dispatch composition;
- sanitized dashboard/read observability;
- strict consumption of already-sanitized Phase 5 production evidence.

A source route/configuration flag does not create standing authorization to invoke a production action.

## Authentication split

### Human routes

Human mutation routes are protected by Cloudflare Access. Worker authorization validates the signed JWT against the expected issuer/JWKS/audience and authenticated identity; trusted header presence alone is insufficient.

### Machine webhook route

GitHub webhook ingress authenticates the original request bytes with `X-Hub-Signature-256` HMAC before repository/event identity is trusted. Webhook payloads are triggers, not canonical mutation evidence.

### Provider/credential boundaries

GitHub App JWTs/installation tokens and Telegram provider credentials remain inside dedicated server-side credential/provider boundaries. Raw secret/token material must not reach domain models, D1, logs, fixtures or browser payloads.

## GitHub integration

Use the dedicated **Rozkalns Control** GitHub App; do not broaden the RPi5 **Rozkalns Automation** App for this product.

The source contains least-privilege read sessions and exact human-decision write boundaries introduced through the completed phases. GitHub remains canonical for:

- repository and default branch;
- branch/SHA;
- issue;
- pull request and merge state;
- review state;
- Actions/check/status state and policy evidence.

Control stores bounded projections/references and decision evidence, not a competing canonical Git history.

## D1 data plane

D1 stores bounded structured control state, including:

- reconciliation delivery lifecycle/deduplication;
- normalized project/GitHub projection state;
- Merge / Needs changes audit and idempotency records;
- Later deferrals;
- notification transitions/intents/attempts/dispatch claims;
- deterministic continuation state.

Secrets are never stored in D1.

A source-controlled migration is only a deploy input. It does not prove remote application. D1 daily Free-plan row-read/row-write limits are enforced; if persistence/reconciliation reads or writes fail because quota/service availability is exhausted, protected actions must fail closed on unavailable evidence rather than continue from incomplete state.

## Queue and event ingestion

Current source flow:

```text
raw GitHub request
  -> verify HMAC
  -> reject invalid
  -> durable delivery-ID claim
  -> enqueue bounded reconciliation identity
  -> Queue consumer re-reads authoritative GitHub state
  -> advance durable lifecycle/projection
  -> notify only on meaningful transition
```

Cloudflare Queues provides at-least-once delivery. Messages may therefore be duplicated, and publication/delivery ordering is not guaranteed. `max_concurrency = 1` bounds concurrent processing but is **not** an ordering contract. Domain sequencing depends on D1 lifecycle/state transitions, idempotency, exact identities and authoritative rereads.

Retries are bounded and exhausted reconciliation messages remain observable through the DLQ path. Queue messages themselves never authorize Merge, deployment or host mutation.

## Human decision flow

```text
NEEDS_ANDRIS card
  -> user chooses Merge / Needs changes / Later
  -> Worker validates Access identity
  -> Worker re-resolves the required current evidence
  -> verify exact expected state (including head/CI/review/policy where applicable)
  -> fail closed if stale/invalid/partial
  -> execute only the exact authorized decision mutation
  -> record bounded decision/result evidence
  -> reconcile resulting state
```

Direct Worker decision routes are the current Phase 3 human-action path. [`CONTROL_AUTHORIZATION.md`](CONTROL_AUTHORIZATION.md) describes a separate privileged-adapter authorization contract and must not be confused with these decision routes.

`Merge` does not imply deployment.

## Notifications and deterministic continuation

Notification transition, delivery-intent, attempt and dispatch-claim state exists in source. Telegram provider/target configuration and notification dispatch Queue composition are also present in source/configuration. Canonical #278 records the bounded Phase 4 Gate B chain as completed.

Those facts do not prove the current Telegram bot secret, chat target, provider availability, Queue backlog or active Worker version. Completed Gate receipts are terminal/non-reusable.

Deterministic continuation planning/reservation/persistence/recovery exists in source. Continuation remains governed by explicit deterministic state and current authorization; Phase 4 completion is not blanket autonomous authority.

## Phase 5 production visibility boundary

Phase 5 is **active**.

The Control consumer is already merged and accepts only an exact allowlist of **already-sanitized** RPi5 production evidence. It validates project/repository identity, source/main and production SHA values, freshness/state fields, deploy impact, runtime/health/rollback/blockers, and rejects over-broad input before projection.

The Control consumer is observational only. Normalized Phase 5 evidence never becomes authority to deploy, mutate production data, invoke rollback, alter permissions or access credentials.

The producer side is deliberately separate:

```text
RPi5 canonical source
  -> capability-specific producer
  -> strict allowlist + sanitization
  -> bounded read-only transport
  -> Control strict consumer
  -> dashboard projection
```

The producer must be defined/reviewed in `RPi5_main` and must be equivalent-or-tighter than the Control allowlist. Control must **not** implement the producer by direct SSH, sudo, generic helper execution, arbitrary filesystem reads, protected runtime/config inspection, database access or host credentials. Canonical #278 currently blocks starting a parallel producer lane until RPi5 continuity explicitly permits it.

## Production authority

The production path remains:

`PR -> CI -> merge -> exact-SHA verification -> deploy-impact classification -> trusted RPi5 controller -> separately authorized helper/action -> health/evidence/rollback`

RPi5 is the production trust boundary. Repository source or Phase 5 normalized evidence cannot replace that authority. Merge authorization is never deployment authorization.

## Future AI extension

A future optional phase may add a provider-neutral agent runtime and isolated execution. It is deliberately outside the MVP and must not receive production credentials or weaken the existing deterministic/owner gates.
