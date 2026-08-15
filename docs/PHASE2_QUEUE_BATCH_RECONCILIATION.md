# Phase 2 — Queue batch reconciliation under the Workers subrequest budget

Issue: #149

## Purpose

Prepare the Cloudflare Queue consumer boundary so a normal Queue batch cannot multiply the existing live GitHub dashboard reread into an unsafe external-subrequest fan-out.

This unit is **source-only**. It does not create or configure a Queue/DLQ, wire a Worker `queue()` entrypoint, bind a webhook secret, enable webhook acceptance, mutate production D1, change Access/routing, or deploy production.

## Platform behavior rechecked 2026-08-15

Current Cloudflare Queues documentation states:

- Worker consumers receive a `MessageBatch` through `queue(batch, env, ctx)`;
- if the handler rejects/throws, an otherwise unsettled batch is retried according to consumer retry configuration;
- individual message `ack()` / `retry()` decisions take precedence over a later batch-level outcome;
- consumer `max_retries` is bounded and an optional `dead_letter_queue` receives retry-exhausted messages.

The existing production dashboard path has already been reduced to a bounded seven external GitHub subrequests for a full six-repository authoritative snapshot. Running that full snapshot once per Queue message would therefore be unsafe for a normal multi-message batch: 10 messages could imply roughly 70 external GitHub calls.

## Source contract

`consumeReconciliationQueueBatch()` adapts a MessageBatch-like input to the existing retry-safe per-message consumer.

For each Queue invocation:

1. fail closed unless `batch.queue` exactly matches the injected expected Queue name;
2. process all messages concurrently through `consumeReconciliationQueueMessage()`;
3. lazily start one shared `reconcileBatch()` promise when the first processable delivery reaches the authoritative reread boundary;
4. every other processable delivery awaits the same promise;
5. preserve each delivery's own D1 lifecycle transition and explicit Queue `ack()` / `retry()`;
6. use `Promise.allSettled()` so one malformed/unhandled message cannot stop valid siblings from reaching an explicit disposition;
7. after all siblings settle, reject the batch adapter if any message remained unhandled.

That last rule intentionally relies on Cloudflare's documented precedence: a later batch rejection does not override an earlier explicit per-message `ack()` or `retry()`. Valid siblings therefore stay settled while only messages with no explicit disposition remain eligible for batch retry.

## Authoritative reread

`createCloudflareReconciliationBatchHandler()` injects the existing `readCloudflareGitHubDashboardSnapshot()` path as the shared batch reread.

The snapshot is not persisted by this adapter. Phase 2's production UI currently reads GitHub live; D1 owns delivery lifecycle evidence. The Queue batch reread exists to ensure accepted webhook delivery processing re-enters the same authoritative GitHub read boundary rather than trusting webhook payload state.

Because the shared reread is lazy:

- an empty batch does not read GitHub;
- a batch containing only terminal `SUCCEEDED` / `DEAD_LETTERED` replays does not read GitHub;
- any number of processable messages in one invocation cause at most one full authoritative dashboard reread.

## Failure semantics

If the shared authoritative reread fails, each processable delivery independently records the existing sanitized `AUTHORITATIVE_RECONCILIATION_FAILED` code, transitions to `RETRY_PENDING`, and explicitly requests Queue retry.

If a single message cannot even reach an explicit disposition (for example malformed schema or durable identity mismatch), its promise remains rejected. Other valid siblings are still allowed to complete. The batch adapter then rejects after all messages settle so Cloudflare can retry only messages not already protected by an explicit per-message disposition.

No raw exception text is written to D1 by this adapter.

## Runtime state after #149

Still disabled and unchanged:

- `src/worker/index.ts` has no `queue()` handler;
- `/api/github/webhook` still passes `secret: null` and `acceptor: null`;
- `wrangler.jsonc` has no Queue producer binding;
- `wrangler.jsonc` has no Queue consumer or DLQ configuration;
- no `GITHUB_WEBHOOK_SECRET` binding exists;
- no production D1 write/migration is performed;
- no Cloudflare traffic/routing/Access mutation is performed;
- GitHub mutation remains disabled.

## Later live activation gate

A separate owner-authorized live gate must still choose and fresh-verify at least:

- exact main Queue and DLQ resource names;
- producer binding name;
- main consumer and DLQ consumer wiring;
- `max_batch_size`, batch timeout, `max_retries`, and DLQ policy;
- exact webhook secret binding and GitHub webhook registration/configuration;
- production D1 schema compatibility;
- Worker entrypoint wiring for webhook acceptance, main Queue processing, DLQ finalization, and protected observability;
- pre/post Queue/DLQ resource identity, Worker version, Access, routing and health evidence;
- rollback/reconciliation behavior if the write boundary is crossed.

#149 authorizes none of those live mutations.

## Deploy impact

**Production deploy: NO.**
