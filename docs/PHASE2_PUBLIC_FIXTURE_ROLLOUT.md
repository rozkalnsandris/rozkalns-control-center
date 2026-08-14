# Phase 2 public fixture rollout

This runbook defines the source contract for issue #90. Merging the source change does **not** authorize either Cloudflare write described below.

## Milestone

Publish the existing mobile-first fixture UI at `control.rozkalns.net` without enabling live GitHub reconciliation, webhook acceptance or any GitHub write path.

The source-controlled production fixture mode is:

- Worker: `rozkalns-control`
- `workers_dev=false`
- `preview_urls=false`
- no source `route`, `routes`, trigger or Custom Domain declaration
- `CONTROL_GITHUB_LIVE_READS=disabled`
- `/api/github/reconcile` returns `404` unless the exact runtime value is `enabled`
- `/api/github/webhook` remains fail-closed with no secret and no durable acceptor
- production D1 binding remains `CONTROL_DB`
- GitHub App private-key binding remains required but is never exposed by these controllers

## Reviewed pre-rollout Cloudflare baseline

The first deploy gate is intentionally pinned to the reviewed pre-rollout state:

- bootstrap version: `38819190-ab13-4865-8976-7b5f7d1c1966`
- non-deployed version: `44fb14ab-b3d4-42eb-aebb-a2612332eef6`
- active deployment: `ca152e0e-295c-47a0-8637-2cd146242e74`
- active traffic: 100% bootstrap version
- workers.dev: disabled
- Preview URLs: disabled
- no `control.rozkalns.net` Custom Domain

If that state changes before an authorized apply, the controller fails closed and the baseline must be reconciled rather than bypassed.

## Step 1 — exact-main non-routable deployment

Plan mode is always non-mutating:

```bash
npm run cf:public-fixture-deploy-gate
```

A future apply requires a separately approved exact current `main` SHA and the exact successful push CI run for that SHA:

```text
authorize Phase 2 public fixture non-routable deploy <exact-main-sha> ci <exact-ci-run-id>
```

The apply controller rechecks:

1. clean local `main`, exact HEAD and fresh `origin/main`;
2. exact successful `main` push CI;
3. pinned Node/Wrangler/source configuration;
4. the reviewed two-version Cloudflare baseline;
5. GitHub App private-key and production D1 binding evidence on the active version;
6. workers.dev and Preview URLs disabled;
7. no existing Custom Domain for the Worker or target hostname.

It runs the full local repository check, then repeats the mutable exact-main/CI/Cloudflare gates immediately before the write.

The sole authorized write is repository-pinned:

```text
wrangler deploy --name rozkalns-control --strict
```

with explicit no-provision/no-auto-create safeguards. Immediately before that write the controller emits:

```text
AUTHORIZATION_CONSUMED=YES
DEPLOY_STARTED=YES
```

After `DEPLOY_STARTED=YES`, failure is **not** retry authorization. Reconcile the live Worker state read-only first.

Successful post-verification must prove one new Worker version is 100% active, workers.dev and Preview URLs remain disabled, no Custom Domain exists, the GitHub App secret and D1 bindings remain present, and the deployed `CONTROL_GITHUB_LIVE_READS` binding is `disabled`.

The exact `DEPLOYED_VERSION_ID` printed by this gate becomes an input to step 2. It is not inferred from “latest”.

## Step 2 — exact-version Custom Domain attach

This is a separate owner gate. Plan mode is non-mutating:

```bash
npm run cf:public-fixture-domain-gate
```

A future apply must bind the same exact current `main` + exact successful push CI to the exact Worker version produced by step 1:

```text
authorize Phase 2 public fixture domain attach control.rozkalns.net <exact-main-sha> ci <exact-ci-run-id> version <exact-version-id>
```

Before the write, the controller proves the exact version exists and is 100% active, fixture-only live-read mode is disabled on that deployed version, workers.dev and Preview URLs remain disabled, and the Worker/hostname have no Custom Domain. It repeats these mutable gates immediately before authorization consumption.

The sole authorized Cloudflare write is the Workers Custom Domain attach request for:

```text
hostname = control.rozkalns.net
service  = rozkalns-control
zone     = rozkalns.net
```

Immediately before the write the controller emits:

```text
AUTHORIZATION_CONSUMED=YES
DOMAIN_ATTACH_STARTED=YES
```

After `DOMAIN_ATTACH_STARTED=YES`, failure is **not** retry authorization. Reconcile domain inventory and active Worker state read-only first.

Post-verification requires exactly one `control.rozkalns.net` domain attached to `rozkalns-control`, while the exact Worker version remains 100% active and fixture-only live-read mode remains disabled.

## Explicitly outside this rollout

Neither source merge nor either plan mode authorizes:

- Cloudflare Access changes;
- live GitHub reconciliation enablement;
- webhook secret or webhook activation;
- Queue/DLQ creation or binding;
- GitHub App permission expansion;
- GitHub write actions;
- D1 write or migration;
- RPi5/host/root mutation.

Step 1 deployment and step 2 domain attach each require their own explicit owner authorization after source merge and fresh exact-main CI.

## Source-task impact

Production deploy: **NO** from the source PR.

Public routing change: **NO** from the source PR.
