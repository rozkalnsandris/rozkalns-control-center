# Phase 2 first public UI rollout

This runbook defines the first intentionally visible Rozkalns Control milestone at `control.rozkalns.net`.

The first public version is deliberately **fixture-only**. It is useful for visual/mobile review, but it does not expose live GitHub reconciliation, webhook durability, Queue/DLQ processing, GitHub writes, production controls, or AI execution.

## Source contract

Production source must preserve all of the following before either live gate is eligible:

- Worker: `rozkalns-control`.
- `workers_dev=false`.
- `preview_urls=false`.
- no source `route`, `routes`, triggers, or custom-domain configuration.
- Static Assets: `./dist/client` with SPA fallback.
- `CONTROL_LIVE_READ_ENABLED=false`.
- required secret contract: `GITHUB_APP_PRIVATE_KEY_PEM`.
- production D1 binding `CONTROL_DB` → `rozkalns-control-production` / `8504e986-faf0-450c-bfb5-41b5dbf8be09`.
- `/api/github/reconcile` returns `503 LIVE_READ_DISABLED` while the flag is false.
- `/api/github/webhook` remains runtime-disabled because no webhook secret or durable acceptor is wired.

The source PR that introduces these gates performs no Cloudflare mutation.

## Gate A — non-routable exact-main UI deploy

Plan mode is credential-free and mutation-free:

```bash
npm run cf:ui-deploy-gate
```

A future apply is separately owner-authorized and must be bound to the then-current exact merged `main` SHA and successful exact-main push CI run:

```text
authorize Phase 2 Cloudflare non-routable UI deploy <exact-main-sha> ci <exact-ci-run-id>
```

The controller revalidates immediately before the write:

- clean local `main` and exact `origin/main`;
- exact successful `CI` push run for that SHA;
- full repository `npm run check`;
- the reviewed fixture-only Wrangler configuration;
- the previously proven Cloudflare two-version / bootstrap-deployment baseline;
- workers.dev and Preview URLs remain disabled;
- no Worker Custom Domain exists.

Only after those checks does it emit:

```text
DEPLOY_STARTED=YES
AUTHORIZATION_CONSUMED=YES
NO_BLIND_RETRY_IF_STOP_AFTER_DEPLOY_STARTED=YES
```

The sole intended write is repository-pinned Wrangler `deploy --strict` with automatic provisioning/creation disabled. A deployment never authorizes public routing.

Postverification requires exactly one new Worker version, 100% active deployment to that version, the required GitHub App secret binding, the exact production D1 binding, workers.dev OFF, Preview URLs OFF, and still no Custom Domain.

If any failure occurs after `DEPLOY_STARTED=YES`, do not rerun the gate. Perform read-only reconciliation first.

Successful evidence includes:

```text
UI_DEPLOY_GATE=PASS
NEW_VERSION_ID=<exact-version-id>
PUBLIC_UI_MODE=FIXTURE_ONLY
LIVE_GITHUB_RECONCILIATION=DISABLED
PUBLIC_ROUTING_CHANGE=NO
```

## Gate B — exact-version Custom Domain attach

Gate B is a distinct authorization. It may only use the exact version returned by a successful Gate A.

Plan mode:

```bash
npm run cf:ui-domain-gate
```

Future authorization format:

```text
authorize Phase 2 Cloudflare UI domain control.rozkalns.net <exact-main-sha> ci <exact-ci-run-id> version <exact-version-id>
```

Before attaching the domain, the controller re-proves:

- exact clean `main` + exact-main successful CI;
- fixture-only source mode (`CONTROL_LIVE_READ_ENABLED=false`);
- the separately authorized version is exactly the version receiving 100% of Worker deployment traffic;
- required GitHub App secret and D1 bindings exist on that exact version;
- workers.dev and Preview URLs remain disabled;
- the Worker has no Custom Domain;
- `control.rozkalns.net` is not already attached to another Worker.

Only then does it emit:

```text
DOMAIN_ATTACH_STARTED=YES
AUTHORIZATION_CONSUMED=YES
NO_BLIND_RETRY_IF_STOP_AFTER_DOMAIN_ATTACH_STARTED=YES
```

The sole intended routing write is Cloudflare Workers Custom Domain attach:

```text
PUT /accounts/{account_id}/workers/domains
hostname=control.rozkalns.net
service=rozkalns-control
zone_name=rozkalns.net
```

Postverification requires one exact matching Custom Domain and the same exact Worker deployment/version as before the attach.

If any failure occurs after `DOMAIN_ATTACH_STARTED=YES`, do not blindly attach again. Reconcile the current domain/deployment state read-only.

## Still out of scope after the first public UI

The visible fixture UI does **not** authorize or imply readiness for:

- enabling live `/api/github/reconcile`;
- Cloudflare Access or authenticated human actions;
- webhook secret creation or GitHub webhook activation;
- Queue/DLQ creation/bindings/consumers;
- real Merge / Needs changes / Retry CI actions;
- GitHub App permission expansion;
- further D1 writes/migrations;
- RPi5/host mutation or production deploys for other projects.

Those remain separate roadmap gates.
