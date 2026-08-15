# Phase 2 — Recoverable webhook D1-to-Queue acceptance

Issue: #142

## Purpose

Define the source-only boundary between an already HMAC-verified GitHub webhook, durable D1 delivery identity, and a future injected Cloudflare Queue producer.

This document does **not** activate a webhook, create or bind a Queue/DLQ, add a webhook secret, mutate GitHub App settings, or deploy production.

## Current source boundaries

The existing webhook route already:

1. reads the raw request body with a 1 MiB cap;
2. verifies `X-Hub-Signature-256` before trusting the payload;
3. obtains repository identity only from the verified payload;
4. rejects unmanaged repositories;
5. invokes a `VerifiedGitHubWebhookAcceptor` only after authentication.

The D1 schema already records delivery identity and lifecycle without webhook payload bodies, tokens, private keys, or secrets.

The Queue message contract is already fixed to schema version 1 and requires an authoritative GitHub reread after delivery.

## Acceptance sequence

For one authenticated GitHub delivery:

```text
verified webhook
  -> D1 claim delivery_id as RECEIVED
  -> if duplicate, inspect durable exact identity + lifecycle
  -> RECEIVED: create strict GITHUB_RECONCILIATION v1 message
  -> await Queue.send(message)
  -> conditional D1 RECEIVED -> ENQUEUED
  -> ACCEPTED
```

A duplicate already in `ENQUEUED`, `PROCESSING`, `RETRY_PENDING`, `SUCCEEDED`, or `DEAD_LETTERED` is returned as `DUPLICATE` without another producer send.

A duplicate still in `RECEIVED` is recoverable work, not completed work, and therefore retries Queue enqueue.

## Why Queue send is awaited

Current Cloudflare Queues documentation states that a producer `send()` promise resolves after the message is confirmed written, and that Queue JavaScript operations throw on failure. Cloudflare also documents that errors from a non-blocking `waitUntil()` Queue send are implicitly ignored.

The webhook acceptance boundary therefore awaits the injected Queue producer directly. A failed send must be visible to the request and must leave the D1 delivery in `RECEIVED` for a later authenticated retry.

## At-least-once boundary

D1 and Cloudflare Queue are separate resources. This source contract does not pretend that Queue send plus D1 state transition form one cross-resource transaction.

The failure window is explicit:

```text
Queue.send succeeds
  -> process fails or D1 conditional ENQUEUED update fails
  -> durable row may remain RECEIVED
  -> later GitHub retry may send the same delivery again
```

This is an intentional **at-least-once** boundary. Any future Queue consumer must be idempotent by `deliveryId` and durable lifecycle state.

The conditional D1 transition matches the exact delivery identity and only permits `RECEIVED -> ENQUEUED`. A zero/multiple-row result fails closed rather than guessing whether the delivery advanced.

## Event-loss observability

A producer failure leaves the row in `RECEIVED`. That state is durable evidence that authenticated delivery acceptance began but enqueue was not proven.

Future consumer work will advance the existing lifecycle:

```text
RECEIVED
  -> ENQUEUED
  -> PROCESSING
  -> SUCCEEDED
       or RETRY_PENDING -> PROCESSING
       or DEAD_LETTERED
```

Future Queue/DLQ activation must separately configure bounded retries and a dead-letter queue so exhausted retries remain observable. Cloudflare documents that, without a configured DLQ, messages that exhaust retries are eventually discarded.

## Permanent safety properties

- public webhook payload data is never authority until HMAC verification succeeds;
- repository identity comes from the verified payload;
- managed-repository policy is rechecked before persistence/enqueue;
- Queue messages contain only bounded normalized identity/trigger metadata;
- `authoritativeReadRequired` is always `true`;
- no raw webhook payload is stored in D1 or queued by this adapter;
- no credentials or secrets enter durable delivery records;
- duplicates cannot silently convert a still-`RECEIVED` delivery into success;
- state drift/races fail closed;
- GitHub mutation remains absent.

## Runtime status after #142

Source-only. The production Worker must continue to invoke the webhook route with:

```ts
{
  secret: null,
  acceptor: null,
}
```

`wrangler.jsonc` must continue to contain no Queue producer/consumer binding and no webhook secret binding.

A future live webhook/Queue/DLQ rollout requires separate source tasks, fresh official Cloudflare/GitHub documentation review, exact resource configuration, tests, and explicit owner authorization for each live trust-boundary mutation.

## Official platform basis checked 2026-08-15

- Cloudflare Queues JavaScript API: producer `Queue.send()` is asynchronous and confirms the write when its promise resolves.
- Cloudflare Queues error handling: JavaScript Queue operations throw on failure.
- Cloudflare Queues delivery model: non-blocking `waitUntil()` producer errors may be ignored, so this acceptance boundary intentionally awaits the send.
- Cloudflare Queues retry/DLQ configuration: exhausted messages go to the configured DLQ; without a DLQ they are eventually discarded.
- Cloudflare D1 Worker API: prepared statements use `prepare().bind().run()` and expose success/results/metadata, including write change counts used by the conditional state transition.
