# Phase 2 Reconciliation Durability Contract

Issue: #21  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration

## Purpose

Define the persistence and message contracts required for reliable GitHub webhook reconciliation before any live Cloudflare D1 database, Queue, DLQ, binding or deployment exists.

This document is source-contract evidence only. It does not authorize Cloudflare resource creation, GitHub App changes, RPi5 mutation or production deployment.

## Current sequencing gate

The current `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md` was re-read on 2026-08-11.

The RPi5 program remains in Phase 3 — CV pull-deploy migration. CV recovery and the cross-repository evidence-directory contract are complete. The first incomplete gate is host installation/proof of the reviewed #140 controller/readiness artifacts with the recurring timer still disabled/inactive.

Control may continue source-only contracts/tests/docs in parallel. Any live Control GitHub App/Cloudflare rollout still requires a fresh reconciliation at the exact rollout step.

## Official Cloudflare basis — rechecked 2026-08-11

Cloudflare D1 migrations are versioned `.sql` files stored in source and applied sequentially. D1 uses SQLite SQL semantics.

Cloudflare Queues provide at-least-once delivery. Consumers may retry failed messages; after `max_retries`, a configured DLQ receives the message. Without a DLQ, exhausted messages are deleted. Queue/DLQ retention is bounded, so a queue cannot be the only long-term record that reconciliation failed.

Workers best practices require retryable/background work to move off the request critical path and require every Promise to be explicitly awaited/returned/voided or attached to `ctx.waitUntil()` when a future live handler is implemented.

## Durable delivery identity

GitHub's `X-GitHub-Delivery` value is the idempotency key.

The initial migration creates `webhook_deliveries` with:

- `delivery_id TEXT PRIMARY KEY`;
- canonical repository/project/event identity;
- versioned message contract;
- explicit lifecycle state;
- attempt count;
- received/updated/completed/dead-letter timestamps;
- one sanitized stable error code for observable failure state.

The schema intentionally does **not** store:

- webhook payload bodies;
- GitHub installation tokens;
- GitHub App JWTs/private keys;
- webhook secrets;
- Cloudflare credentials;
- arbitrary exception text that might contain sensitive data.

A future live persistence adapter must use atomic insert/claim semantics so two concurrent deliveries with the same `delivery_id` cannot both become new work.

## Delivery lifecycle

Allowed states:

```text
RECEIVED
  -> ENQUEUED
  -> PROCESSING
       -> SUCCEEDED
       -> RETRY_PENDING -> PROCESSING
       -> DEAD_LETTERED

RETRY_PENDING -> DEAD_LETTERED
```

`SUCCEEDED` and `DEAD_LETTERED` are terminal.

Rules:

- no direct `RECEIVED -> SUCCEEDED` shortcut;
- attempt count increments when processing begins;
- retry/dead-letter transitions require a stable non-secret error code;
- success clears the active error code;
- terminal states cannot re-enter processing without a separately designed replay contract.

This state machine is deliberately narrower than Cloudflare's implementation details. It records Control's deterministic reconciliation outcome, not every internal Queue event.

## Queue message contract

Current schema version: `1`.

Current message kind: `GITHUB_RECONCILIATION`.

The message contains only:

- schema version;
- kind;
- GitHub delivery ID;
- GitHub event name;
- canonical managed repository;
- canonical Control project ID;
- received timestamp;
- `authoritativeReadRequired: true`.

It deliberately does not contain the webhook body, PR title/body, issue text, credentials or GitHub API evidence. The consumer must re-read GitHub authoritatively.

The runtime parser:

- rejects unknown message versions/kinds;
- rejects unknown fields rather than silently carrying them;
- re-resolves repository/project identity through the managed-project allow-list;
- rejects project/repository mismatches;
- rejects non-authoritative messages;
- validates bounded opaque identifiers and UTC timestamps.

Unknown future fields therefore require an explicit versioned contract change.

## DLQ observability

Cloudflare DLQ retention is not durable application history.

When a future live consumer reaches retry exhaustion, Control must persist `DEAD_LETTERED` with a sanitized error code/timestamp before or while the DLQ path is handled. The dashboard/error projection can then remain observable after the Queue/DLQ message itself expires.

Do not use raw queue attempts or DLQ presence as the only source of durable failure truth.

## Source-only boundary

Issue #21 intentionally does not create:

- a D1 database;
- a D1 binding in `wrangler.jsonc`;
- a Queue producer binding;
- a Queue consumer;
- a DLQ;
- a Worker `queue()` handler;
- Cloudflare secrets;
- a Cloudflare deployment;
- a live GitHub transport or mutation path.

The source-boundary regression test checks that the new contracts do not contain a D1/Queue runtime binding, `fetch()` transport or `env.*` access, and that `wrangler.jsonc` remains binding-free for D1/Queues.

## Planned live follow-up

A later separately gated Phase 2 task may:

1. create/bind D1;
2. apply source-controlled migrations;
3. create Queue + DLQ;
4. implement atomic delivery claim/transition persistence;
5. implement a Queue producer after successful HMAC authentication;
6. implement a Queue consumer that performs authoritative GitHub rereads;
7. record retries and terminal DLQ failure durably;
8. expose observable reconciliation failure state.

Before that task, re-read current Cloudflare docs, current master #1 and current `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md`.

## Deploy impact

`DEPLOY_REQUIRED=no` for issue #21. The current work is source/tests/docs only.
