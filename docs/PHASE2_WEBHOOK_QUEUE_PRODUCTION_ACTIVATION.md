# Phase 2 — webhook / Queue production activation

Issues: #155, #157, #158

## Purpose

Activate the already-merged Phase 2 GitHub webhook → D1 durability → Cloudflare Queue → authoritative GitHub reread → retry / DLQ → delivery-observability runtime without weakening the Control Panel read-only GitHub permission model.

This document describes the reviewed source contract and the one-shot production gate. Merging source does not itself create Cloudflare resources, write a secret, change Access, alter the GitHub App registration or deploy the Worker.

## Permanent trust boundaries

- GitHub remains the source of truth.
- The GitHub App keeps its current read-only repository permissions.
- GitHub webhook requests are trusted only after HMAC-SHA256 verification over the exact raw request body.
- The webhook payload is not persisted; D1 stores only bounded delivery identity and lifecycle metadata.
- The Worker runtime becomes write-capable only when `CONTROL_WEBHOOK_RUNTIME_ENABLED` is exactly `true` and all required bindings validate.
- `workers.dev` and Preview URLs stay disabled.
- `control.rozkalns.net` remains protected by the existing parent Cloudflare Access application.
- Only the exact webhook path `control.rozkalns.net/api/github/webhook` receives a more-specific Access bypass application. GitHub HMAC remains mandatory there.
- Production writes require an exact owner authorization generated from a fresh plan. Generic approval or a prior deployment authorization must never be reused.

## GitHub App ping handshake

Saving or enabling a GitHub App webhook causes GitHub to send a `ping` delivery. A GitHub App `ping` is not required to contain repository identity, so the activation source treats it as a distinct authenticated handshake:

1. require the normal webhook headers;
2. verify HMAC-SHA256 against `GITHUB_WEBHOOK_SECRET`;
3. if `X-GitHub-Event` is exactly `ping`, return HTTP 200 / `{ "status": "PING" }` with `Cache-Control: no-store`;
4. do not call the D1 delivery store and do not send a Queue message;
5. all non-`ping` events still require HMAC-verified `repository.full_name` and managed-repository policy before durability work.

An invalid ping signature is rejected fail-closed.

## Reviewed Queue topology

The source declares:

- main Queue: `rozkalns-control-reconciliation`;
- DLQ: `rozkalns-control-reconciliation-dlq`;
- producer binding: `RECONCILIATION_QUEUE` → `rozkalns-control-reconciliation`.

Main consumer policy:

- batch size 10;
- batch timeout 5 seconds;
- max retries 3;
- retry delay 30 seconds;
- max concurrency 1;
- dead-letter queue `rozkalns-control-reconciliation-dlq`.

DLQ consumer policy:

- batch size 10;
- batch timeout 5 seconds;
- max retries 3;
- max concurrency 1;
- no second dead-letter queue.

One main Queue invocation performs at most one full authoritative dashboard reread while D1 lifecycle and `ack()` / `retry()` decisions remain individual per delivery.

## Required secrets

Required secret names:

- `GITHUB_APP_PRIVATE_KEY_PEM` — already present in production;
- `GITHUB_WEBHOOK_SECRET` — new for this activation.

Secret values must never be committed, pasted into an issue/PR, logged by the gate or placed in a CLI argument. The Lenovo apply wrapper supplies the webhook secret through `CONTROL_GITHUB_WEBHOOK_SECRET`; the gate writes only `GITHUB_WEBHOOK_SECRET` to a mode-0600 temporary JSON file for `wrangler deploy --secrets-file`, then removes it in `finally` handling. The same secret is later entered into the GitHub App webhook settings.

## Cloudflare Access identity model

The production gate follows the current Cloudflare Access application model instead of depending on legacy `domain` equality.

### Parent application proof

`CONTROL_ACCESS_TOKEN` is first used against protected `/api/health`. A successful canary proves that Cloudflare Access accepted the token for the current Control application.

Only after that successful request, the gate decodes the already-accepted application JWT and requires:

- JWT `type` exactly `app`;
- exactly one bounded Application Audience (`aud`) value.

The Access application inventory is then searched for exactly one `self_hosted` application whose API `aud` equals that validated token audience. During apply, the plan-generated parent Access application ID must also match. Duplicate audience matches, missing matches, invalid IDs or audience drift fail closed.

The gate does **not** identify the parent application by application name or by `app.domain === "control.rozkalns.net"`.

### Application destinations

Current Access targeting is verified through `destinations`. For public destinations, the reviewed target is represented as:

```json
{
  "type": "public",
  "uri": "control.rozkalns.net/api/github/webhook"
}
```

When reading an older Access application that does not expose `destinations`, the helper accepts the legacy `domain` field only as a bounded compatibility fallback. If `destinations` is present, it takes precedence; a conflicting legacy `domain` value cannot override it.

The activation creates one more-specific self-hosted Access application with both the primary domain and explicit modern destination:

- name: `Rozkalns Control GitHub webhook`;
- domain: `control.rozkalns.net/api/github/webhook`;
- `destinations`: one public destination with URI `control.rozkalns.net/api/github/webhook`;
- App Launcher disabled.

Any pre-existing application with that exact public destination **or** the reserved application name blocks first activation and requires reconciliation rather than a blind rerun.

It receives exactly one application-local policy:

- name: `Bypass GitHub webhook HMAC endpoint`;
- decision: `bypass`;
- precedence: 1;
- include: Everyone.

This exception is exact-path only. `/`, `/api/health`, `/api/github/dashboard`, `/api/github/webhook-deliveries` and the remaining host continue to require the parent Access protection.

## D1 preflight

The plan/apply gate checks production D1 using read-only SQL. It requires the exact `webhook_deliveries` column set from migration `0001_reconciliation_core.sql` and records the row count.

The count is included in owner authorization. Apply refuses to continue if it changes between plan and final prewrite verification.

## One-shot gate

Script:

`node scripts/cloudflare-webhook-queue-activation-gate.mjs`

### Plan

Plan requires:

- exact current `main` SHA;
- exact successful main push CI run ID;
- temporary Cloudflare API token with required read permissions;
- short-lived `CONTROL_ACCESS_TOKEN` for protected Control canaries.

Plan performs no Cloudflare mutation. It verifies:

- clean exact-main checkout and origin/main equality;
- exact-main CI success;
- full local `npm run check`;
- reviewed source configuration and pinned Wrangler version;
- protected `/api/health` through the supplied Access token;
- parent Access application identity by the validated token Application Audience (`aud`);
- active Worker version/deployment and dormant pre-activation bindings;
- custom domain identity;
- absence of the exact webhook Access application by modern destination/reserved-name evidence;
- absence of both target Queues;
- exact D1 delivery schema and delivery baseline count;
- `workers.dev` and Preview URLs disabled.

Plan prints the parent Access app ID and AUD plus one exact `OWNER_AUTHORIZATION=...` string bound to main/CI/current Worker version/current deployment/domain/parent Access app/D1 delivery count and `queues absent` baseline.

### Apply

Apply additionally requires:

- exact current version, deployment, domain ID, parent Access app ID and delivery count printed by plan;
- `CONTROL_OWNER_AUTHORIZATION` byte-for-byte equal to plan output;
- `CONTROL_GITHUB_WEBHOOK_SECRET` containing the password-manager secret;
- the same class of temporary Cloudflare API token;
- the same class of short-lived Access user token.

Before the first write, apply repeats repository, CI, Worker, domain, Access-AUD identity, Queue, D1 and protected-health checks. It also proves the Access token audience did not change during final prewrite.

Immediately before mutation it prints:

- `WRITE_STARTED=YES`;
- `AUTHORIZATION_CONSUMED=YES`;
- `NO_BLIND_RETRY_IF_STOP_AFTER_WRITE_STARTED=YES`.

After that point the authorization is spent even if a later operation fails.

Apply performs only these bounded writes:

1. create the exact main Queue;
2. create the exact DLQ;
3. deploy the reviewed Worker/config with the webhook secret supplied out of band and automatic resource creation disabled;
4. prove one new 100%-active Worker version, exact Queue topology, secret binding, runtime flag, unchanged custom domain and disabled workers.dev/Preview URLs;
5. prove protected health and bounded webhook-delivery observability through the parent Access app;
6. create the exact-path webhook Access application with explicit `destinations`;
7. create its single Bypass / Everyone policy;
8. re-read Access state and prove the same parent app by the same Application Audience and expected ID;
9. send a synthetic HMAC-signed `ping` to the public webhook path and require HTTP 200 / `PING` / `no-store`;
10. re-check protected health, parent AUD and delivery observability.

A synthetic ping is side-effect-free and does not create a D1 delivery row or Queue message.

If any failure occurs after `WRITE_STARTED=YES`, the script prints `POST_WRITE_STATE=RECONCILE_REQUIRED`. **No blind retry** is allowed. Fresh inventory and a new explicit owner authorization are required before rollback or continuation.

## GitHub App finalization after Cloudflare PASS

The Cloudflare gate deliberately does not modify GitHub App registration.

Only after `WEBHOOK_QUEUE_ACTIVATION_GATE=PASS`:

1. open GitHub **Settings → Developer settings → GitHub Apps → Rozkalns Control**;
2. enable **Active** under Webhooks;
3. set Webhook URL to `https://control.rozkalns.net/api/github/webhook`;
4. paste the **same secret** used by the Cloudflare apply gate;
5. keep SSL verification enabled;
6. subscribe only to `check_run`, `issues`, `pull_request`, `pull_request_review`, `pull_request_review_thread`, `push`, `workflow_run`;
7. do not change repository permissions;
8. save;
9. verify GitHub's real `ping` returns HTTP 200.

`status` remains excluded because it would require separately reviewed Commit statuses permission growth.

## Post-activation canary

After GitHub App save/ping succeeds, a controlled benign event on one managed repository should prove:

`GitHub delivery → HMAC → D1 RECEIVED → Queue ENQUEUED → PROCESSING → authoritative reread → SUCCEEDED`.

The protected `/api/github/webhook-deliveries` endpoint is the delivery lifecycle evidence source. Raw webhook payloads and secret values must never appear there.

## Rollback / reconciliation

There is no automatic rollback after first write. If activation stops after the write boundary:

- do not rerun the same command;
- do not reuse owner authorization;
- inventory both Queues and their producer/consumers;
- inventory active Worker version/deployment and bindings;
- inventory exact parent Access app by AUD/ID and webhook Access app/policy by destination/ID;
- record D1 delivery lifecycle counts;
- check whether GitHub App webhook settings changed;
- choose forward-complete or rollback from fresh evidence;
- obtain a new exact owner authorization before further mutation.

A rollback that removes live webhook processing first prevents new GitHub deliveries, then reconciles any `RECEIVED`, `ENQUEUED`, `PROCESSING` or `RETRY_PENDING` rows before deleting Queue/Access resources or disabling runtime bindings.

## Deploy impact

#158 is a source-only correction to the activation gate and does not itself deploy production.

**Production deploy for #157: YES — REQUIRED, NOT YET EXECUTED.**

After #158 is merged and exact-main CI passes, #157 must run a completely fresh read-only PLAN. Any previous failed PLAN baseline is obsolete and cannot authorize apply.
