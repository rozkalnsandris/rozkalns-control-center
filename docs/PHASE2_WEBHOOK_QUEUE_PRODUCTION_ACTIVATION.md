# Phase 2 — webhook / Queue production activation

Issue: #155

## Purpose

Activate the already-merged Phase 2 GitHub webhook → D1 durability → Cloudflare Queue → authoritative GitHub reread → retry / DLQ → delivery-observability runtime without weakening the Control Panel read-only GitHub permission model.

This document describes the reviewed source contract and the one-shot production gate. Merging the source does not itself create Cloudflare resources, write a secret, change Access, alter the GitHub App registration or deploy the Worker.

## Permanent trust boundaries

- GitHub remains the source of truth.
- The GitHub App keeps its current read-only repository permissions. No GitHub mutation permission is added by #155.
- GitHub webhook requests are trusted only after HMAC-SHA256 verification over the exact raw request body.
- The webhook payload is not persisted; D1 stores only bounded delivery identity and lifecycle metadata.
- The Worker runtime becomes write-capable only when `CONTROL_WEBHOOK_RUNTIME_ENABLED` is exactly `true` and all required bindings validate.
- `workers.dev` and Preview URLs stay disabled.
- `control.rozkalns.net` remains protected by the existing parent Cloudflare Access application.
- Only the exact webhook path `control.rozkalns.net/api/github/webhook` receives a more-specific Access bypass application. That bypass removes human Access authentication only for this exact machine endpoint; GitHub HMAC remains mandatory there.
- Production writes require an exact owner authorization generated from a fresh plan. Generic approval or a prior deployment authorization must never be reused.

## GitHub App ping handshake

Saving or enabling a GitHub App webhook causes GitHub to send a `ping` delivery. A GitHub App `ping` is not required to contain repository identity, so the activation source treats it as a distinct authenticated handshake:

1. require the normal webhook headers;
2. verify HMAC-SHA256 against `GITHUB_WEBHOOK_SECRET`;
3. if `X-GitHub-Event` is exactly `ping`, return HTTP 200 / `{ "status": "PING" }` with `Cache-Control: no-store`;
4. do not call the D1 delivery store and do not send a Queue message;
5. all non-`ping` events still require the HMAC-verified `repository.full_name` and managed-repository policy before durability work.

An invalid ping signature is rejected with the same fail-closed webhook rejection as any other event.

## Reviewed Queue topology

The production source configuration declares exactly two Queue resources by name:

- main Queue: `rozkalns-control-reconciliation`;
- dead-letter Queue: `rozkalns-control-reconciliation-dlq`.

The Worker producer binding is:

- `RECONCILIATION_QUEUE` → `rozkalns-control-reconciliation`.

Main consumer policy:

- batch size: 10;
- batch timeout: 5 seconds;
- max retries: 3;
- retry delay: 30 seconds;
- max concurrency: 1;
- dead-letter queue: `rozkalns-control-reconciliation-dlq`.

DLQ consumer policy:

- batch size: 10;
- batch timeout: 5 seconds;
- max retries: 3;
- max concurrency: 1;
- no second dead-letter queue.

The already-merged batch coordinator performs at most one full authoritative dashboard reread per main Queue invocation while keeping D1 lifecycle and `ack()` / `retry()` decisions individual per delivery.

## Required secrets

The reviewed Wrangler source declares two required secret names:

- `GITHUB_APP_PRIVATE_KEY_PEM` — already present in production;
- `GITHUB_WEBHOOK_SECRET` — new for this activation.

The webhook secret value must never be committed, pasted into an issue/PR, logged by the gate or placed in a CLI argument.

Before apply, create one high-entropy value in a password manager. The Lenovo apply wrapper supplies that value to the gate through `CONTROL_GITHUB_WEBHOOK_SECRET`. The gate writes only `GITHUB_WEBHOOK_SECRET` to a mode-0600 temporary JSON file and passes it to `wrangler deploy --secrets-file`. Wrangler preserves existing secrets that are omitted from that file, so the already-proven GitHub App private key remains attached. The temporary file is deleted in `finally` handling.

The **same secret** must later be pasted into the GitHub App webhook settings. Do not generate a second value in GitHub.

## Cloudflare Access layout

The existing parent Access application for `control.rozkalns.net` remains unchanged.

The activation creates one more-specific self-hosted Access application:

- name: `Rozkalns Control GitHub webhook`;
- domain: `control.rozkalns.net/api/github/webhook`;
- App Launcher: disabled.

It receives exactly one application-local policy:

- name: `Bypass GitHub webhook HMAC endpoint`;
- decision: `bypass`;
- precedence: 1;
- include: Everyone.

This public exception is intentionally exact-path only. `/`, `/api/health`, `/api/github/dashboard`, `/api/github/webhook-deliveries` and the remaining host continue to require the parent Access protection.

## D1 preflight

The plan/apply gate checks production D1 using read-only SQL through the D1 query endpoint. It requires the exact `webhook_deliveries` column set from migration `0001_reconciliation_core.sql` and records the current row count.

The count is included in the owner authorization. Apply refuses to proceed if the count changes between plan and final prewrite verification. This makes the first activation fail closed if an unexpected writer already exists.

## One-shot gate

Script:

`node scripts/cloudflare-webhook-queue-activation-gate.mjs`

### Plan

Plan requires:

- exact current `main` SHA;
- exact successful main push CI run ID;
- temporary Cloudflare API token with the read permissions needed for Worker, Queue, Access and D1 inventory;
- short-lived `CONTROL_ACCESS_TOKEN` for protected Control canaries.

Plan performs no Cloudflare mutation. It verifies:

- clean exact-main checkout and origin/main equality;
- exact-main CI success;
- full local `npm run check`;
- reviewed source configuration and pinned Wrangler version;
- active Worker version/deployment and dormant pre-activation bindings;
- custom domain identity;
- existing parent Access application;
- absence of the exact webhook Access application;
- absence of both target Queues;
- exact D1 delivery schema and delivery baseline count;
- protected `/api/health` canary;
- `workers.dev` and Preview URLs disabled.

Plan prints a single authorization string containing the exact main/CI/current version/current deployment/domain/parent Access app/D1 delivery count and the `queues absent` baseline.

### Apply

Apply additionally requires:

- the exact current version, deployment, domain ID, parent Access app ID and delivery count printed by plan;
- `CONTROL_OWNER_AUTHORIZATION` equal byte-for-byte to the plan output;
- `CONTROL_GITHUB_WEBHOOK_SECRET` containing the password-manager secret;
- the same temporary Cloudflare API token;
- the same class of short-lived Access user token.

Before the first write, apply repeats repository, CI, Worker, domain, Access, Queue, D1 and health checks. Immediately before mutation it prints:

- `WRITE_STARTED=YES`;
- `AUTHORIZATION_CONSUMED=YES`;
- `NO_BLIND_RETRY_IF_STOP_AFTER_WRITE_STARTED=YES`.

After that point the authorization is spent even if a later operation fails.

Apply performs these bounded writes in order:

1. create the exact main Queue;
2. create the exact DLQ;
3. deploy the reviewed Worker/config with the webhook secret supplied through the temporary secrets file and automatic resource creation disabled;
4. prove one new 100%-active Worker version, exact Queue producer/consumer topology, secret binding, runtime flag, unchanged custom domain, and disabled workers.dev/Preview URLs;
5. prove protected health and bounded webhook-delivery observability through the parent Access app;
6. create the exact-path webhook Access application;
7. create its single Bypass / Everyone policy;
8. re-read Access state and prove the parent app is unchanged;
9. send a synthetic HMAC-signed `ping` directly to the public webhook path and require HTTP 200 / `PING` / `no-store`;
10. re-check protected health and delivery observability.

A synthetic ping is side-effect-free and therefore does not create a D1 delivery row or Queue message.

If any failure occurs after `WRITE_STARTED=YES`, the script prints `POST_WRITE_STATE=RECONCILE_REQUIRED`. **No blind retry** is allowed. Fresh inventory and a new explicit owner authorization are required before any rollback or continuation.

## GitHub App finalization after Cloudflare PASS

The Cloudflare gate deliberately does not modify the GitHub App registration because the connected GitHub tooling does not expose that trust-boundary setting.

Only after `WEBHOOK_QUEUE_ACTIVATION_GATE=PASS`:

1. open GitHub **Settings → Developer settings → GitHub Apps → Rozkalns Control**;
2. enable **Active** under Webhooks;
3. set Webhook URL to `https://control.rozkalns.net/api/github/webhook`;
4. paste the **same secret** used by the Cloudflare apply gate;
5. keep SSL verification enabled;
6. under **Subscribe to events**, select only:
   - `check_run`;
   - `issues`;
   - `pull_request`;
   - `pull_request_review`;
   - `pull_request_review_thread`;
   - `push`;
   - `workflow_run`;
7. do not change repository permissions;
8. save the GitHub App configuration;
9. verify the real GitHub `ping` delivery returns HTTP 200.

`status` is intentionally **not** included in this activation because receiving that event requires the Commit statuses permission, which is not part of the current read-only App permission set. If standalone commit-status webhook invalidation later proves necessary, permission growth must be reviewed and owner-authorized separately.

## Post-activation canary

After GitHub App webhook save/ping succeeds, the next controlled canary should use a benign event on one managed repository and verify the full chain:

`GitHub delivery → HMAC → D1 RECEIVED → Queue ENQUEUED → PROCESSING → authoritative reread → SUCCEEDED`.

The protected `/api/github/webhook-deliveries` endpoint is the source of truth for delivery lifecycle evidence. Raw webhook payloads and secret values must never appear there.

## Rollback / reconciliation

There is no automatic rollback after the first write because partial removal could lose delivery evidence or create an unreviewed routing state.

If activation stops after the write boundary:

- do not rerun the same command;
- do not reuse the same owner authorization;
- record whether each Queue exists and whether consumers/producers are attached;
- record active Worker version/deployment and required bindings;
- record exact parent and webhook Access app/policy IDs;
- record D1 delivery lifecycle counts;
- check whether GitHub App webhook settings were changed;
- decide a forward-complete or rollback plan from that fresh state;
- obtain a new exact owner authorization for the selected mutation.

A rollback that removes live webhook processing must first prevent new GitHub deliveries, then reconcile any `RECEIVED`, `ENQUEUED`, `PROCESSING` or `RETRY_PENDING` rows before deleting Queue/Access resources or disabling runtime bindings.

## Deploy impact

After #155 source is merged:

**Production deploy: YES — REQUIRED, NOT YET EXECUTED.**

The source merge and exact-main CI do not themselves authorize the production activation. The plan-generated exact owner authorization is still mandatory.
