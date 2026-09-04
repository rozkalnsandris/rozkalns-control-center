# Phase 4 Telegram pre-provider LIVE controller

This document defines the repository-owned **Gate A** execution contract for Telegram activation after the source-only pre-LIVE controller has frozen an exact production envelope.

Gate A deliberately stops before provider delivery. It creates/configures the dispatch Queue in a paused state, uploads exactly one Worker candidate containing the two Telegram secret bindings, smoke-tests that exact candidate at 0% normal traffic, promotes it to 100%, then proves the Queue is still paused. A later **Gate B** must separately authorize delivery resume. Gate A never calls Telegram.

## Why a dedicated controller is required

The generic `.github/workflows/production-worker-composite-live.yml` intentionally covers only one Worker version upload plus two deployment writes. Telegram activation also needs a Queue and two new secret bindings, so that generic `UPLOAD1:DEPLOY2` authorization is not sufficient by itself.

Cloudflare's deployed-secret semantics also matter. Ordinary `wrangler secret put` creates and immediately deploys a new Worker version, which would bypass the reviewed candidate-at-0% smoke model. Gate A therefore passes the two protected Telegram values to the **single** `wrangler versions upload --secrets-file ...` operation. Secrets omitted from that file are preserved from the previous version. Secret values are written only to a mode-0600 temporary file and never emitted in the public receipt.

The source configuration declares `NOTIFICATION_DISPATCH_QUEUE`, so the Queue must exist before the strict version upload. Gate A creates it explicitly with automatic provisioning disabled and pauses delivery before a consumer is added. Cloudflare Queues continue to accept/store messages while delivery is paused; the consumer therefore cannot invoke the Telegram provider until a separately authorized resume.

## Exact Gate A sequence

The workflow `.github/workflows/phase4-telegram-preprovider-live.yml` is manual `workflow_dispatch` on `main` only and rejects workflow reruns.

Before the first write it must prove:

- exact current `main == approved_sha`;
- exact successful `main` push CI run supplied by the authorization;
- exact successful Phase 4 Telegram pre-LIVE controller run on the same SHA;
- exact currently active Worker version/deployment, single version at 100%;
- baseline `/api/health` reports that exact active Worker version;
- `rozkalns-control-notification-dispatch` is still absent;
- all required protected inputs are present;
- the owner authorization text exactly matches the enumerated Gate A envelope.

Only then may it perform the bounded mutations, in this order:

1. create exactly one Queue named `rozkalns-control-notification-dispatch`;
2. set `delivery_paused=true` exactly once and verify it read-only;
3. create exactly one Worker consumer with batch size 10, wait 5000 ms, max retries 3, retry delay 60 s and max concurrency 1, with no DLQ;
4. create one private temporary JSON file containing exactly `CONTROL_TELEGRAM_BOT_TOKEN` and `CONTROL_TELEGRAM_CHAT_ID` from protected environment secrets;
5. run exactly one strict `wrangler versions upload --secrets-file ...`, with automatic provisioning/creation disabled;
6. attach the baseline at 100% and candidate at 0% in exactly one deployment write;
7. GET `/api/health` through Cloudflare Access while forcing the exact candidate via `Cloudflare-Workers-Version-Overrides`, and require the returned version ID to equal the uploaded candidate;
8. re-prove `main`, the split deployment and paused Queue before promotion;
9. promote that exact candidate to 100% in exactly one second deployment write;
10. reconcile read-only: candidate is the sole 100% version, the normal hostname converges to exact service + candidate version identity within at most six GET probes separated by 5 seconds, Queue remains paused, one consumer remains present, and `main` has not moved.

## Bounded mutation ceiling

Gate A authorizes at most:

- Queue create: 1;
- Queue pause: 1;
- Queue consumer create: 1;
- Telegram secret bindings included on the candidate: 2;
- Worker version upload: 1;
- Worker deployment writes: 2.

It authorizes **zero** D1 migrations/writes, provider-delivery resume operations, Telegram API requests, Queue purge/delete operations, permission changes, DNS/Access/route changes, rollback or cleanup.

The Queue must remain paused after a successful Gate A receipt.

## Secret source boundary

`CONTROL_TELEGRAM_BOT_TOKEN` and `CONTROL_TELEGRAM_CHAT_ID` must already exist as protected secrets in the GitHub environment used by the workflow (`production-worker-deploy`). Their creation/rotation in GitHub is not performed by this workflow. Missing values fail before the first Cloudflare mutation.

The workflow never accepts Telegram values as `workflow_dispatch` inputs and never prints them. Adding, replacing or rotating those GitHub environment secrets is a separate credential-store mutation unless an owner authorization explicitly includes it.

## One-shot/fail-closed semantics

Authorization is consumed when the Queue creation begins, which is the first live mutation. From that point onward, any error, timeout, response ambiguity, state drift or verification failure produces a STOP receipt and **no automatic mutation retry, rollback or cleanup**.

The post-promotion normal-host health check is a bounded read-only convergence exception, not a retry of any mutation: Gate A may issue at most six GET probes with 5 seconds between probes. PASS still requires exact `.status == "ok"`, `.service == rozkalns-control` and `.workerVersion == candidate_version`. If that identity does not converge inside the bounded window, Gate A fails closed with `FINAL_HEALTH_CONVERGENCE_TIMEOUT` and performs no alternate deployment, rollback or cleanup.

A failed run must never be rerun. Reconcile actual production state read-only and obtain a new exact authorization for any recovery or continuation.

## Gate B

A successful Gate A receipt still does not authorize Telegram delivery. The next gate is a separate read-only reconciliation followed by explicit owner authorization for exactly the provider-delivery resume mutation. Gate B must bind the exact post-Gate-A Worker version/deployment, Queue identity, paused state, consumer settings and any bounded backlog/metrics evidence available at that time.

Until Gate B is authorized and executed:

- Queue delivery remains paused;
- Telegram provider request count remains zero;
- no provider send is authorized.

## Source/live distinction

Merging this workflow is source readiness only. It does not provision protected GitHub environment secrets and does not execute Gate A. After merge, current `main`, exact-main CI, production baseline and a fresh Telegram pre-LIVE run must be collected again before a new Gate A owner authorization is eligible.
