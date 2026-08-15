# Phase 2 — Queue consumer retry and DLQ lifecycle

Issue: #144

## Purpose

Complete the **source-only** durability contract after the verified-webhook acceptance boundary introduced by #142/#143.

This document does **not** activate a Cloudflare Queue consumer, create a Queue or DLQ, add a Queue binding, enable the GitHub webhook runtime, mutate production D1, or deploy production.

## Existing upstream boundary

The upstream source path is already defined as:

```text
verified GitHub webhook
  -> durable D1 delivery = RECEIVED
  -> strict GITHUB_RECONCILIATION v1 Queue message
  -> await Queue.send()
  -> durable D1 delivery = ENQUEUED
```

The Queue message contains only bounded delivery/event/repository/project identity and requires an authoritative GitHub reread. Raw webhook bodies, credentials, tokens, private keys and webhook secrets are excluded.

## Main Queue consumer contract

For one strict v1 reconciliation message:

```text
parse + validate message
  -> read exact D1 delivery
  -> prove delivery/repository/project/event/version/receivedAt identity
  -> terminal replay? ACK without reconciliation
  -> ENQUEUED / RETRY_PENDING / interrupted PROCESSING
  -> durable processing attempt (attempt_count + 1)
  -> injected authoritative reconciliation executor
       success -> durable SUCCEEDED -> ACK
       failure -> durable RETRY_PENDING with stable code -> RETRY
```

The consumer adapter never stores raw exception text. A reconciliation failure is represented only by the stable non-secret code:

```text
AUTHORITATIVE_RECONCILIATION_FAILED
```

The Queue message remains a trigger. The injected executor must perform the authoritative GitHub reread required by the existing reconciliation contract; the webhook/Queue payload itself is never canonical decision evidence.

## At-least-once and interrupted processing

Cloudflare Queues are treated as **at-least-once**, not exactly-once.

A Worker may fail after D1 has recorded `PROCESSING` but before it can record `RETRY_PENDING` or `SUCCEEDED`. The same Queue message may therefore be delivered again while D1 still says `PROCESSING`.

The D1 processing-attempt operation intentionally permits re-entry from:

```text
ENQUEUED
RETRY_PENDING
PROCESSING
```

Each re-entry increments `attempt_count` and refreshes the processing/last-attempt timestamps. This is an attempt operation, not a claim that duplicate execution is impossible. The injected reconciliation path must remain delivery-idempotent/convergent.

Terminal `SUCCEEDED` and `DEAD_LETTERED` replays are acknowledged without executing reconciliation again.

## Retry ordering

A transient authoritative reconciliation failure follows this order:

```text
PROCESSING
  -> D1 RETRY_PENDING + stable error code
  -> Queue retry request
```

If the D1 transition cannot be proven, the adapter throws instead of requesting a Queue retry. The surrounding Queue runtime can then apply its normal failure/retry semantics. This prevents acknowledging or explicitly retrying work whose durable lifecycle state is unknown.

## DLQ finalizer

Cloudflare documents that messages reaching the configured consumer retry limit are sent to the configured dead-letter queue. Without a DLQ, exhausted messages are eventually discarded.

The source-only DLQ finalizer therefore uses this order:

```text
strict message parse
  -> exact D1 identity proof
  -> non-terminal delivery state proof
  -> D1 DEAD_LETTERED + QUEUE_RETRY_EXHAUSTED
  -> ACK DLQ message
```

The finalizer accepts `ENQUEUED`, `PROCESSING` or `RETRY_PENDING` because infrastructure or D1 failures can exhaust Queue retries before a normal processing transition is durably completed. This is why the lifecycle contract permits the infrastructure-only `ENQUEUED -> DEAD_LETTERED` terminal transition.

The stable final error code is:

```text
QUEUE_RETRY_EXHAUSTED
```

Malformed/unsupported Queue messages or D1 identity/state drift fail closed and are not acknowledged by these source adapters.

## D1 safety properties

All lifecycle writes:

- use prepared bound statements;
- match exact delivery id, repository, project id and event name;
- constrain the expected current lifecycle state;
- require exactly one affected row;
- reject malformed timestamps and attempt counts;
- accept only bounded uppercase stable error codes;
- never persist raw exception messages, webhook payloads, tokens, private keys or secrets.

The D1 schema is unchanged. #144 uses the lifecycle columns already present in `0001_reconciliation_core.sql`.

## Runtime status after #144

Still disabled and source-only:

- `src/worker/index.ts` has no `queue()` handler;
- GitHub webhook route is still called with `secret: null` and `acceptor: null`;
- `wrangler.jsonc` has no Queue producer, consumer or DLQ binding;
- no Queue/DLQ Cloudflare resource is created;
- no production D1 write/migration is performed;
- GitHub mutation remains disabled;
- no production deployment is part of this task.

A future live Queue/DLQ rollout must separately define and verify exact Queue names, consumer configuration, retry budget, DLQ binding, webhook secret/binding, Worker runtime wiring, production D1 compatibility, rollback/reconciliation evidence, and explicit owner authorization before any live trust-boundary mutation.

## Official platform basis checked 2026-08-15

Current Cloudflare documentation confirms:

- a Queue consumer batch is acknowledged only after the handler/promise and registered `waitUntil()` work complete successfully;
- thrown/rejected consumer work causes retry according to the consumer retry settings;
- individual messages expose `ack()` and `retry()` controls;
- `max_retries` controls retry exhaustion;
- a configured `dead_letter_queue` receives messages that reach the retry limit;
- without a DLQ, exhausted messages are eventually discarded;
- D1 prepared statements support `prepare().bind().run()` and return write metadata/change counts used by these exact conditional transitions.
