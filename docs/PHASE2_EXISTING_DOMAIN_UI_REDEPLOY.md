# Phase 2 existing-domain UI redeploy

This runbook covers reviewed Worker/UI redeploys **after** `control.rozkalns.net` has already been attached as the production Custom Domain.

It is intentionally separate from the first-rollout `cloudflare-ui-deploy-gate.mjs`, whose historical contract requires no Custom Domain.

## Source and routing model

Cloudflare documents `wrangler deploy` as the normal Worker deployment command. The production `wrangler.jsonc` deliberately contains no `route` or `routes` key and keeps `workers_dev=false`; routing is therefore managed separately from Wrangler source configuration. The redeploy gate must prove the already-established Custom Domain before and after the Worker deployment and must never perform a domain write itself.

## Gate

Entry point:

```text
node scripts/cloudflare-ui-redeploy-gate.mjs
```

Plan mode is credential-free and non-mutating.

Apply mode requires:

- exact current `main` SHA;
- exact successful `main` push CI run id;
- exact currently active Worker version id;
- exact currently active Worker deployment id;
- exact existing `control.rozkalns.net` domain id;
- the temporary `rozkalns-control-setup` token in `CLOUDFLARE_API_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID=70e29dbca0e8363358659102d2b74178`;
- an exact one-shot owner authorization matching all of the above.

The controller prints the exact authorization format in plan mode.

## Prewrite requirements

The gate fails closed unless all of the following are proven twice before the write:

- local branch is `main`, worktree is clean, local and `origin/main` equal the authorized SHA;
- the supplied CI run is successful exact-main push CI;
- fixture-only production config remains unchanged, including `CONTROL_LIVE_READ_ENABLED=false`;
- the authorized version/deployment is still the latest active Worker deployment at 100%;
- required GitHub App secret and production D1 bindings are present;
- workers.dev and Preview URLs are disabled;
- exactly one Worker Custom Domain exists and it is the authorized `control.rozkalns.net` domain id for `rozkalns-control` in zone `rozkalns.net`;
- the observed Worker version inventory does not change during preflight.

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

There is no Workers-domain PUT/DELETE, no D1 write/migration, no GitHub write, no live-read enablement and no RPi5 mutation.

After `DEPLOY_STARTED=YES`, a failure or ambiguous response consumes the authorization. **Do not retry blindly.** Perform read-only Cloudflare reconciliation first.

## Postverify

A successful redeploy proves:

- exactly one newly observed Worker version;
- that new version receives 100% of active Worker deployment traffic;
- the active deployment id changed;
- required secret and D1 bindings are present on the new version;
- workers.dev and Preview URLs remain disabled;
- the exact same authorized Custom Domain id remains uniquely attached;
- public routing was not changed by the gate.

Successful terminal evidence includes:

```text
UI_REDEPLOY_GATE=PASS
AUTHORIZATION_CONSUMED=YES
NEW_VERSION_ID=<id>
ACTIVE_DEPLOYMENT_ID=<id>
ACTIVE_TRAFFIC_PERCENT=100
CUSTOM_DOMAIN=control.rozkalns.net
DOMAIN_ID=<unchanged-id>
PUBLIC_UI_MODE=FIXTURE_ONLY
LIVE_GITHUB_RECONCILIATION=DISABLED
WORKERS_DEV=DISABLED
PREVIEW_URLS=DISABLED
PUBLIC_ROUTING_CHANGE=NO_EXISTING_DOMAIN_PRESERVED
```

## Authorization boundary

Preparing, reviewing or merging this gate does not authorize a production redeploy. Each production redeploy requires a new explicit owner authorization tied to the then-current exact main SHA, successful main CI, current Worker version/deployment and current domain id.
