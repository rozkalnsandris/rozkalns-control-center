# Phase 4 Telegram Gate B LIVE executor

This document defines the source contract for the final Phase 4 provider-delivery gate. It does not itself authorize or execute production delivery. A merge establishes source readiness only; Gate B can run only after fresh exact-main evidence and a separate explicit owner LIVE authorization.

## Why the paused backlog is not a send count

The successful read-only evidence run `33874660152` observed a paused dispatch Queue backlog of 1211 messages / 124733 bytes while D1 held 17 notification transitions, 17 delivery intents, zero delivery attempts and zero dispatch claims. The Queue's oldest-message timestamp was `0`, so message age was unknown.

That backlog does not mean 1211 Telegram sends. Reconciliation intentionally may enqueue a deterministic `deliveryId` again after its durable D1 intent already exists. Queue duplication is therefore replay work, not provider-send authority. Before crossing the provider boundary the deployed Worker:

- parses only the minimal versioned dispatch message containing the deterministic `deliveryId`;
- re-reads the durable delivery intent and attempt history from D1;
- computes the canonical READY / WAIT / DELIVERED / TERMINAL_FAILURE / EXHAUSTED decision;
- acquires the durable dispatch claim before a provider call;
- treats an existing or ambiguous durable claim as a replay barrier rather than resend permission;
- acknowledges already delivered, terminal, exhausted or ambiguous-claimed work without another provider invocation.

The reviewed production retry policy is `maxAttempts=2` with a 60-second retry delay. The backlog count is never used as an authorization ceiling for Telegram requests. Provider eligibility comes from one durable intent plus its durable attempt/claim history. Once the Queue is resumed, future live intents may also be delivered under the same runtime contract.

## Backlog policy: REPLAY_SAFE_DURABLE_INTENT_DRAIN

Gate B uses the explicit policy `REPLAY_SAFE_DURABLE_INTENT_DRAIN`.

Under this policy a non-zero paused backlog is eligible for a later separately authorized resume only when all of the following are freshly proven on the exact Gate B source SHA:

1. current `main` equals the approved SHA and the supplied exact-main push CI run succeeded on that SHA;
2. the supplied `phase4-telegram-d1-live-scope-readonly.yml` run succeeded on the same SHA;
3. the exact Worker deployment/version remains the sole version at 100% traffic with the reviewed notification flags, target, retry policy, Queue binding and protected Telegram bindings;
4. D1 resource identity, notification migrations 0003–0006 and the four notification tables are still valid;
5. transition and intent row counts equal the exact owner-authorized counts and remain one-to-one for the single reviewed target;
6. delivery-attempt rows are exactly zero and dispatch-claim rows are exactly zero before the first provider boundary;
7. the exact dispatch Queue is still paused and the exact Worker consumer still has batch size 10, max wait 5000 ms, max retries 3, retry delay 60 s, max concurrency 1 and no DLQ;
8. immediately before mutation, the Queue backlog message count and byte count equal the exact owner-authorized snapshot;
9. the owner authorization text exactly binds all of that evidence and the `REPLAY_SAFE_DURABLE_INTENT_DRAIN` policy.

No stale-age cutoff is introduced. The oldest-message value may be unknown, and message age is not the durable provider-eligibility source. No Queue purge is used: purging would be an additional destructive mutation and is unnecessary for replay safety because the durable D1 planner/claim path already determines whether a message may cross the provider boundary.

## Exact Gate B mutation envelope

The workflow `.github/workflows/phase4-telegram-gate-b-live.yml` is manual, main-only, rejects workflow reruns and runs in the `production-worker-deploy` environment.

It requires both the ordinary Cloudflare production token and `CLOUDFLARE_D1_READ_TOKEN`. The D1 token is used only for guarded one-statement `SELECT` queries. If that read credential is not available in the LIVE environment, Gate B fails before the first production mutation; this source slice does not create or copy secrets.

After all initial evidence passes, Gate B performs a second final prewrite reconciliation. The final operations are deliberately ordered so that the fresh Queue metrics GET is the last remote evidence read before mutation. Any changed main SHA, Worker deployment/version, D1 count, pristine attempt/claim state, Queue pause state, consumer setting, backlog count or backlog bytes causes STOP before authorization is consumed.

The complete production mutation envelope is exactly one Queue `delivery_paused=false` PATCH against the exact authorized Queue ID.

Gate B authorizes zero:

- D1 migrations or D1 writes;
- Queue create, pause, purge, delete, pull, peek or message ACK operations;
- Queue consumer create/change/delete operations;
- Worker version upload or deployment writes;
- secret creation, rotation, export or deletion;
- direct Telegram API requests from the workflow;
- Cloudflare Access, DNS, route, binding or permission changes;
- rollback or alternate deployment actions.

The workflow itself never calls Telegram. The consequence of the Queue resume is different: once `delivery_paused=false` is accepted, the already-deployed Worker consumer may begin invoking Telegram for durable intents that pass the replay-safe D1 dispatch gates, and future live intents may also be delivered.

## One-shot and fail-closed behavior

The exact owner authorization is consumed when the Queue resume PATCH begins. Before that point, any error leaves `AUTHORIZATION_CONSUMED=NO`.

After the PATCH begins, any transport error, timeout, ambiguous Cloudflare response, state drift or failed post-write verification produces STOP with `AUTHORIZATION_CONSUMED=YES`. There is no automatic retry, rollback or production cleanup. In particular, an ambiguous PATCH outcome is never converted into permission to issue a second PATCH.

After the write the executor performs read-only confirmation only. It proves the Queue now reports `delivery_paused=false`, `main` still equals the approved SHA, the same Worker deployment/version remains active and the same consumer topology remains present. It deliberately does not require attempts/claims to remain zero after resume because provider delivery may already be active at that point.

A failed Gate B run must not be rerun. Reconcile actual production state read-only and obtain a new exact authorization for any continuation or recovery mutation.

## Exact owner authorization shape

The workflow reconstructs one exact authorization string from its inputs:

`AUTHORIZE PHASE4 TELEGRAM GATE B LIVE — MAIN <sha> — CI <run> — READONLY <run> — DEPLOYMENT <deployment> — VERSION <version> — QUEUE <queue-id> — CONSUMER <consumer-id> — D1 TRANSITIONS <n> INTENTS <n> ATTEMPTS 0 CLAIMS 0 — BACKLOG <messages> MESSAGES <bytes> BYTES — POLICY REPLAY_SAFE_DURABLE_INTENT_DRAIN — QUEUE RESUME 1 — DIRECT TELEGRAM REQUEST 0 — NO RETRY — NO ROLLBACK — NO CLEANUP`

Any character-level mismatch fails before mutation.

## Fresh evidence requirement after merge

Run `33874660152` is design evidence for this source lane, not future LIVE authorization. Once the Gate B executor source is merged, the approved SHA changes. Therefore LIVE eligibility requires:

- fresh current `main` containing the merged executor;
- successful exact-main CI on that SHA;
- a fresh successful D1/LIVE-scope read-only run on that same SHA;
- fresh Queue paused/backlog and D1 evidence from that run;
- a separate owner LIVE authorization constructed from those fresh values.

The previous run cannot be substituted because the executor requires the read-only run's `head_sha` to equal the exact approved Gate B source SHA.

## Source versus production state

Repository source can prove the intended Gate B validation and mutation envelope. It does not prove that production still has the same Worker deployment, Queue state, D1 counts, secrets or authorization state. Those facts are re-read at Gate B execution time.

Creating this workflow, testing it, opening a PR, reviewing it or merging it performs no LIVE mutation and grants no LIVE authorization.
