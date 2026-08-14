# Phase 2 live read-only production gate

This runbook covers the one-time transition of `control.rozkalns.net` from the already-public fixture Worker to the merged live read-only GitHub dashboard.

## Source target

The reviewed source target has `CONTROL_LIVE_READ_ENABLED="true"` in `wrangler.jsonc`. The GitHub App private key remains a Worker secret; the client id and installation id remain non-secret plain-text bindings. The production D1 binding is preserved and this gate performs no D1 write.

The historical `cloudflare-ui-redeploy-gate.mjs` remains fixture-only and intentionally continues to require `CONTROL_LIVE_READ_ENABLED=false`; it must not be weakened or reused for this transition.

## Gate

Entry point:

```text
node scripts/cloudflare-live-read-enable-gate.mjs
```

Plan mode is credential-free and non-mutating.

Apply mode requires:

- exact current `main` SHA;
- exact successful `main` push CI run id;
- exact current active Worker version id;
- exact current active Worker deployment id;
- exact existing `control.rozkalns.net` Custom Domain id;
- temporary `rozkalns-control-setup` token in `CLOUDFLARE_API_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID=70e29dbca0e8363358659102d2b74178`;
- exact one-shot owner authorization printed by plan mode.

## Prewrite proof

Before the sole write, and again immediately before it, the gate fails closed unless it proves:

- local `main`, clean worktree, local HEAD and `origin/main` equal the authorized SHA;
- supplied CI is successful exact-main push CI;
- reviewed source has live read enabled while workers.dev and Preview URLs remain disabled;
- reviewed GitHub App client/installation ids, secret contract, D1 binding and SPA assets contract are unchanged;
- authorized Worker version/deployment is still the latest active deployment at exactly 100%;
- the current active Worker version still has `CONTROL_LIVE_READ_ENABLED=false` plus the reviewed GitHub App and required secret/D1 bindings;
- exactly the authorized existing Custom Domain is attached;
- public `GET /api/github/dashboard` still returns `503 LIVE_READ_DISABLED` with `Cache-Control: no-store`;
- Worker version inventory does not change during preflight.

## Sole intended write

Immediately before the write the gate emits:

```text
DEPLOY_STARTED=YES
AUTHORIZATION_CONSUMED=YES
NO_BLIND_RETRY_IF_STOP_AFTER_DEPLOY_STARTED=YES
```

The sole intended live write is repository-pinned Wrangler:

```text
wrangler deploy \
  --name rozkalns-control \
  --strict \
  --experimental-provision=false \
  --experimental-auto-create=false \
  --install-skills=false
```

There is no Workers-domain write, GitHub write, permission change, secret mutation, D1 migration/write, webhook activation, Queue/DLQ change, Access change or RPi5 mutation.

After `DEPLOY_STARTED=YES`, any failure or ambiguous response consumes the authorization. Do not retry blindly; reconcile Cloudflare state read-only first.

## Postverify

A successful transition proves:

- exactly one newly observed Worker version;
- the new version receives 100% of active deployment traffic and the deployment id changed;
- the new version has `CONTROL_LIVE_READ_ENABLED=true`;
- reviewed GitHub App client/installation ids, private-key secret and production D1 bindings remain present;
- workers.dev and Preview URLs remain disabled;
- the exact same Custom Domain id remains uniquely attached;
- public routing is unchanged;
- public `/api/github/dashboard` returns HTTP 200, `no-store`, the normalized dashboard shape and exactly the six managed repositories;
- the live observational snapshot exposes no `MERGE_READY` state and no action other than `OPEN_PR`.

Successful terminal evidence includes:

```text
LIVE_READ_ENABLE_GATE=PASS
AUTHORIZATION_CONSUMED=YES
NEW_VERSION_ID=<id>
ACTIVE_DEPLOYMENT_ID=<id>
ACTIVE_TRAFFIC_PERCENT=100
CUSTOM_DOMAIN=control.rozkalns.net
DOMAIN_ID=<unchanged-id>
PUBLIC_UI_MODE=LIVE_READ_ONLY
CONTROL_LIVE_READ_ENABLED=TRUE
GITHUB_MUTATION=DISABLED
WEBHOOK_RUNTIME=DISABLED
WORKERS_DEV=DISABLED
PREVIEW_URLS=DISABLED
PUBLIC_ROUTING_CHANGE=NO_EXISTING_DOMAIN_PRESERVED
```

## Authorization boundary

Merging this source does not authorize the production transition. The live deploy requires a fresh explicit owner authorization tied to the then-current exact main SHA, exact successful main CI and fresh Cloudflare version/deployment/domain observations.
