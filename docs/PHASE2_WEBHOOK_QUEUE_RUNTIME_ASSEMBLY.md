# Phase 2 — dormant webhook / Queue runtime assembly

Issue: #152

## Purpose

Assemble the already-proven Phase 2 webhook, D1 durability, Queue reconciliation, DLQ finalization and delivery-observability components at the Worker boundary without activating any live webhook or Queue resource.

This unit is **source-only**. It creates no Cloudflare Queue or DLQ, adds no Queue binding, adds no webhook secret, registers no GitHub webhook, performs no remote D1 write or migration, changes no Access/routing setting and deploys nothing.

## Fail-closed activation contract

The runtime is eligible to assemble only when `CONTROL_WEBHOOK_RUNTIME_ENABLED` is exactly the string `true`.

Any other value, including a missing value, `false`, `TRUE`, whitespace variants or booleans, resolves to `DISABLED`. The resolver checks this flag before inspecting any other binding.

If the flag is exactly `true`, every required dependency must also validate before a write-capable adapter is returned:

- `GITHUB_WEBHOOK_SECRET` must be a non-empty string;
- `CONTROL_DB` must expose the expected D1 prepare boundary;
- `RECONCILIATION_QUEUE` must expose the Queue producer send boundary;
- the existing GitHub App private-key, client-id and installation-id bindings must satisfy the already-merged Cloudflare GitHub runtime validator.

Partial or malformed configuration resolves to `INVALID`. Neither `DISABLED` nor `INVALID` returns a webhook acceptor, delivery reader or Queue consumer.

## Runtime composition

When all source-level prerequisites are explicitly present, the assembly reuses the previously merged components instead of duplicating their logic:

1. GitHub webhook request
   - raw-body HMAC verification remains in `github-webhook-route.ts`;
   - verified repository identity remains policy-checked;
   - `WebhookReconciliationAcceptor` claims the delivery in D1;
   - the reconciliation message is sent through the injected Queue producer;
   - D1 moves from `RECEIVED` to `ENQUEUED` only after the producer send resolves.
2. Main reconciliation Queue
   - only the exact source identity `rozkalns-control-reconciliation` is accepted;
   - the #151 batch adapter coalesces a full authoritative GitHub dashboard reread to at most one read per Queue invocation;
   - each delivery keeps its own PROCESSING / SUCCEEDED / RETRY_PENDING state and explicit `ack()` / `retry()` decision.
3. Dead-letter Queue
   - only the exact source identity `rozkalns-control-reconciliation-dlq` is accepted;
   - each valid non-terminal delivery is finalized through the existing `finalizeReconciliationDeadLetter()` lifecycle;
   - valid siblings are allowed to settle even when another DLQ message is malformed; the batch adapter reports a sanitized failure after all siblings settle.
4. Delivery observability
   - `/api/github/webhook-deliveries` is connected to the already-bounded D1 reader only when the runtime is `READY`;
   - the route remains GET-only, no-store and bounded to 50 diagnostic entries.

Unknown Queue names fail before D1 or GitHub work.

## Worker entrypoint

`src/worker/index.ts` now contains the dormant `queue(batch, env)` entrypoint and the delivery-observability route wiring.

That source wiring alone does **not** activate Cloudflare Queues. Cloudflare only invokes a Worker as a Queue consumer when Queue consumer configuration exists, and producer writes require a producer binding. This repository intentionally adds neither in #152.

For ordinary HTTP traffic, `/api/github/webhook` continues to receive `secret: null` and `acceptor: null` whenever the runtime resolves to `DISABLED` or `INVALID`, preserving the existing 503 fail-closed behavior.

## Production configuration remains unchanged

`wrangler.jsonc` deliberately remains free of:

- `queues` producer configuration;
- Queue consumer configuration;
- `dead_letter_queue` and `max_retries`;
- `RECONCILIATION_QUEUE` binding;
- `GITHUB_WEBHOOK_SECRET` secret declaration;
- `CONTROL_WEBHOOK_RUNTIME_ENABLED` activation variable.

Therefore merging #152 does not make production runtime-ready by itself and does not authorize any live mutation.

## Separate live activation gate still required

A later owner-authorized production gate must fresh-verify and pin at least:

- exact current `main` SHA and exact-main CI;
- exact main Queue and DLQ resource identities;
- producer binding identity and consumer configuration;
- batch size / timeout / bounded retry policy and DLQ relationship;
- webhook secret binding and GitHub webhook registration;
- D1 schema compatibility and empty/known delivery baseline;
- Worker version/deployment, custom-domain, Access and health baseline;
- webhook canary delivery through D1 → Queue → authoritative reread → SUCCEEDED;
- retry and DLQ observability without raw payload or secret exposure;
- rollback/reconciliation behavior after any write boundary.

That gate must have its own exact owner authorization. #152 authorizes none of these live operations.

## Deploy impact

**Production deploy: NO.**
