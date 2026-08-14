# Phase 2 live read-only production gate

This runbook covers the one-time transition of `control.rozkalns.net` from the already-public fixture Worker to the merged live read-only GitHub dashboard.

## Source target

The reviewed source target has `CONTROL_LIVE_READ_ENABLED="true"` in `wrangler.jsonc`. The GitHub App private key remains a Worker secret; the client id and installation id remain non-secret plain-text bindings. The production D1 binding is preserved and this gate performs no D1 write.

The SPA assets configuration keeps `not_found_handling="single-page-application"` for browser navigation, but explicitly sets `assets.run_worker_first=["/api/*"]`. This makes Control API requests invoke the Worker before Static Assets/SPA fallback while preserving SPA navigation for the UI.

The historical `cloudflare-ui-redeploy-gate.mjs` remains fixture-only and intentionally continues to require `CONTROL_LIVE_READ_ENABLED=false`; it must not be weakened or reused for this transition.

## Existing Cloudflare Access boundary

`control.rozkalns.net` is already protected by Cloudflare Access. An unauthenticated request can therefore be intercepted by Access and receive the Access sign-in HTML before the Worker is reached. That response is not a valid Worker canary and must not be treated as one.

This rollout preserves the existing Access protection. It does not add a bypass, public API exception, Service Auth policy or service token.

For this owner-present one-shot gate, obtain a user-scoped Access token interactively on the operator machine. The `--quiet` flag is mandatory so `cloudflared access login` does not print the JWT to the terminal:

```text
cloudflared access login --quiet https://control.rozkalns.net
export CONTROL_ACCESS_TOKEN="$(cloudflared access token -app=https://control.rozkalns.net)"
```

Do not print, echo, paste or persist `CONTROL_ACCESS_TOKEN`. If an Access JWT is ever printed or exposed, treat it as compromised, do not reuse it, and log out through `https://control.rozkalns.net/cdn-cgi/access/logout` before generating a fresh token.

The gate sends the token only in the `cf-access-token` header of protected canary requests. It never logs or persists the token and removes `CONTROL_ACCESS_TOKEN` from child-process environments, including Git, npm and Wrangler processes.

After the one-shot operation or any stopped attempt, remove the shell copy:

```text
unset CONTROL_ACCESS_TOKEN
```

## JSON response boundary

Cloudflare control-plane reads and the Access-authenticated Worker canaries are JSON protocols. The rollout helpers fail closed unless the response declares an `application/json` media type before calling `response.json()`.

A non-JSON response, including an Access sign-in page, SPA shell or intermediary error page, is treated as a controlled gate failure. The gate reports the HTTP/media-type boundary and does not dump the response body, credentials or upstream HTML into rollout evidence.

## Custom Domain identity boundary

Cloudflare exposes a Custom Domain `id` as an immutable string. The gate therefore treats the observed domain id as an opaque identifier rather than assuming an undocumented fixed hexadecimal length or representation.

The supplied id must be non-empty and bounded, and the prewrite/postverify checks still require exact equality of domain id, `control.rozkalns.net`, Worker service `rozkalns-control` and zone `rozkalns.net` in both the service-scoped and hostname-scoped domain inventories.

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
- exact existing `control.rozkalns.net` Custom Domain id as freshly returned by Cloudflare;
- temporary `rozkalns-control-setup` token in `CLOUDFLARE_API_TOKEN`;
- fresh user-scoped Access token in `CONTROL_ACCESS_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID=70e29dbca0e8363358659102d2b74178`;
- exact one-shot owner authorization printed by plan mode.

The Cloudflare API token and Access user token are separate credentials for separate boundaries. The Access token is never forwarded to Wrangler.

## Prewrite proof

Before the sole write, and again immediately before it, the gate fails closed unless it proves:

- local `main`, clean worktree, local HEAD and `origin/main` equal the authorized SHA;
- supplied CI is successful exact-main push CI;
- reviewed source has live read enabled while workers.dev and Preview URLs remain disabled;
- reviewed GitHub App client/installation ids, secret contract, D1 binding and SPA assets contract are unchanged;
- `/api/*` is explicitly Worker-first while SPA fallback remains enabled for UI navigation;
- authorized Worker version/deployment is still the latest active deployment at exactly 100%;
- the current active Worker version still has `CONTROL_LIVE_READ_ENABLED=false` plus the reviewed GitHub App and required secret/D1 bindings;
- exactly the authorized existing Custom Domain identity is attached;
- the Access-authenticated `GET /api/health` reaches the currently deployed Worker and returns JSON HTTP 200 with the stable payload `status=ok`, `service=rozkalns-control`, `phase=phase-0`;
- Cloudflare API and Access-canary reads do not cross the JSON media-type boundary;
- Worker version inventory does not change during preflight.

The prewrite canary intentionally uses `/api/health`, which existed in the already-deployed fixture Worker before the live dashboard route was introduced in source. Fixture-only runtime state is proved separately and authoritatively by the active Worker version binding `CONTROL_LIVE_READ_ENABLED=false`. The future `/api/github/dashboard` route is therefore not required to exist before the deploy that introduces it.

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

There is no Workers-domain write, GitHub write, permission change, secret mutation, D1 migration/write, webhook activation, Queue/DLQ change, Access policy/configuration change or RPi5 mutation.

After `DEPLOY_STARTED=YES`, any failure or ambiguous response consumes the authorization. Do not retry blindly; reconcile Cloudflare state read-only first.

## Postverify

A successful transition proves:

- exactly one newly observed Worker version;
- the new version receives 100% of active deployment traffic and the deployment id changed;
- the new version has `CONTROL_LIVE_READ_ENABLED=true`;
- reviewed GitHub App client/installation ids, private-key secret and production D1 bindings remain present;
- workers.dev and Preview URLs remain disabled;
- the exact same Custom Domain identity remains uniquely attached;
- existing Cloudflare Access protection remains in front of the hostname;
- public routing is unchanged except for the reviewed request-order rule that sends `/api/*` through the same Worker before SPA assets;
- the Access-authenticated `/api/github/dashboard` returns `application/json`, HTTP 200, `no-store`, the normalized dashboard shape and exactly the six managed repositories;
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
ACCESS_PROTECTION=PRESERVED
GITHUB_MUTATION=DISABLED
WEBHOOK_RUNTIME=DISABLED
WORKERS_DEV=DISABLED
PREVIEW_URLS=DISABLED
PUBLIC_ROUTING_CHANGE=NO_EXISTING_DOMAIN_PRESERVED
```

## Authorization boundary

Merging this source does not authorize the production transition. The live deploy requires a fresh explicit owner authorization tied to the then-current exact main SHA, exact successful main CI and fresh Cloudflare version/deployment/domain observations. The Access user token is operational canary authentication only; it is not production deploy authorization.
