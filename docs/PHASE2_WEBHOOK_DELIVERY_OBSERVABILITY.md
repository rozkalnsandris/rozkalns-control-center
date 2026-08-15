# Phase 2 — webhook delivery observability

Issue: #146

## Purpose

Make webhook/Queue delivery loss and stuck lifecycle state observable before any live Queue/DLQ activation.

This unit is **source-only**. It does not wire a production route, enable the GitHub webhook runtime, create or configure Cloudflare Queue/DLQ resources, add Queue bindings, bind a webhook secret, mutate production D1, change Access/routing, or deploy production.

## Existing durable lifecycle

The existing `webhook_deliveries` table already records bounded non-secret lifecycle evidence:

```text
RECEIVED
  -> ENQUEUED
  -> PROCESSING
       -> SUCCEEDED
       -> RETRY_PENDING -> PROCESSING
       -> DEAD_LETTERED
```

A delivery can also reach `DEAD_LETTERED` from `ENQUEUED` or `RETRY_PENDING` when infrastructure/retry exhaustion occurs before a normal processing transition can complete.

## Read model

`D1WebhookDeliveryObservabilityReader` performs exactly two bounded logical reads:

1. aggregate delivery counts by lifecycle state;
2. read the oldest non-`SUCCEEDED` diagnostic rows, capped at 51 rows so that at most 50 are returned and `diagnosticsTruncated=true` proves additional evidence exists.

No webhook payload body, GitHub token, private key, webhook secret or Cloudflare credential is selected or returned.

Returned diagnostics contain only:

- delivery id;
- managed repository and project id;
- event name;
- lifecycle state;
- attempt count;
- received/update timestamps;
- stable bounded error code, when present;
- deterministic disposition.

## Deterministic health semantics

One explicit UTC `observedAt` drives the projection.

The source contract uses a 15-minute stale threshold:

- `SUCCEEDED` only, or no deliveries -> `HEALTHY`;
- recent non-terminal work and no dead letters -> `ACTIVE`;
- any `DEAD_LETTERED` delivery -> `ATTENTION`;
- any non-terminal delivery whose `updated_at` is at least 15 minutes old -> `ATTENTION`.

Diagnostic dispositions are:

- `ACTIVE` — non-terminal and newer than the stale threshold;
- `STALE` — non-terminal and at/older than the stale threshold;
- `DEAD_LETTERED` — terminal retry exhaustion evidence.

The reader fails closed on unsupported states, duplicate aggregate state rows, invalid counts/attempts, unmanaged repository identity, project/repository mismatch, malformed stable error codes, malformed timestamps, or future/inconsistent timestamps.

## Boundedness and truncation

The API never returns an unbounded delivery history. It asks D1 for `limit + 1`, returns at most 50 diagnostics, and sets an explicit truncation bit when more rows exist.

Because diagnostics are ordered by `updated_at ASC`, the oldest outstanding evidence is inspected first. If the oldest returned non-terminal rows are not stale, later non-terminal rows cannot be older than them. Aggregate counts independently preserve the exact total `DEAD_LETTERED` count even when diagnostics are truncated.

## Source-only route adapter

`handleGitHubWebhookObservabilityRequest()` defines the future protected read boundary at:

```text
GET /api/github/webhook-deliveries
```

Contract:

- GET only;
- no query parameters;
- `Cache-Control: no-store` on success and failure;
- injected reader only — no hidden environment lookup;
- `503 WEBHOOK_OBSERVABILITY_DISABLED` when no reader is provided;
- `503 WEBHOOK_OBSERVABILITY_FAILED` for sanitized read/projection failure.

The adapter is intentionally **not imported or called by `src/worker/index.ts`** in #146.

## Current runtime state after #146

Still disabled:

- GitHub webhook route receives `secret: null` and `acceptor: null`;
- Worker has no `queue()` handler;
- observability route is not connected to the Worker entry point;
- `wrangler.jsonc` has no Queue producer/consumer/DLQ configuration;
- no webhook secret binding exists;
- no production D1 write/migration occurs;
- GitHub mutation remains disabled;
- no production deploy is included.

## Platform basis checked 2026-08-15

Current Cloudflare Queues documentation confirms:

- consumer messages expose individual `ack()` and `retry()` controls;
- `max_retries` bounds delivery retries;
- exhausted messages are sent to the configured `dead_letter_queue`;
- without a DLQ configured, exhausted messages are eventually discarded.

Those platform semantics are why `RETRY_PENDING`, `DEAD_LETTERED`, stale non-terminal state and explicit truncation are treated as operational evidence rather than hidden implementation details.

## Future live gate

A later live activation must be separately owner-authorized and must still define and verify at least:

- exact Queue and DLQ names;
- producer/consumer bindings;
- retry budget and batch behavior;
- webhook secret binding and GitHub webhook configuration;
- concrete authoritative reconciliation executor;
- protected observability route wiring;
- production D1 schema compatibility;
- pre/post Queue, DLQ, Access, routing and Worker-version evidence;
- rollback/reconciliation behavior.

#146 does not authorize or perform any of those live mutations.
