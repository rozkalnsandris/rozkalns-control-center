# Phase 5 RPi5 observation — post-activation Worker verification

Issue #616 adds a deterministic **GET-only** verifier for the Worker state expected after a separately authorized `WORKER_ACTIVATE` run. This source does not perform activation and does not grant LIVE authority.

Canonical implementation:

- workflow: `.github/workflows/phase5-rpi5-observation-worker-post-activation-verify.yml`
- verifier: `scripts/phase5-rpi5-observation-worker-post-activation-verify.mjs`
- machine contract: `.github/phase5-rpi5-observation-worker-post-activation-verifier-contract.json`
- GitHub Environment declaration: `production-readonly-reconcile`

## Evidence boundary

The verifier is intentionally separate from the pre-activation dormant-baseline preflight. It does **not** assume that `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED` is absent or false. Its expected post-activation state is exact plain-text `true`.

A future manual run must bind public-safe inputs for:

- exact current `main` SHA;
- exact successful push CI run on that SHA;
- exact expected active Worker deployment ID;
- exact expected active Worker version ID;
- SHA-256 of the reviewed non-ingest binding inventory.

The expected deployment/version and binding digest must come from the bounded activation/candidate evidence for the exact rollout being verified. Source merge alone does not supply or prove those production values.

## GET-only verification

The verifier uses the Workers Scripts read credential already provided through `CLOUDFLARE_API_TOKEN` and performs only these Cloudflare reads:

1. `GET /accounts/{account_id}/workers/scripts/{script_name}/deployments`;
2. `GET /accounts/{account_id}/workers/scripts/{script_name}/versions/{version_id}`.

It fails closed unless all of the following are true:

- GitHub `main` still equals the approved SHA and the named CI run is a successful exact-main push CI run;
- the expected deployment is current and contains exactly one version at 100% traffic;
- that exact version ID equals the expected version input;
- `CONTROL_RPI5_OBSERVATION_INGEST_ENABLED` exists exactly once as `plain_text` with value `true`;
- `CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS` exists exactly once as protected `secret_text`, while no secret value field is observable;
- `CONTROL_DB` still targets database ID `8504e986-faf0-450c-bfb5-41b5dbf8be09`;
- the canonical SHA-256 of every non-ingest binding equals the expected digest from reviewed activation evidence;
- the active version runtime compatibility date and flags equal the current source configuration;
- active version script identity metadata is present.

The exact expected version ID is the primary identity binding for the code/config artifact being verified. Cloudflare documents a Worker version as capturing code, static assets, bindings and compatibility settings, while a deployment determines which version serves traffic.

## Public-safe receipt

Success emits `PHASE5_WORKER_POST_ACTIVATION_VERIFY=PASS` plus the approved SHA, CI run, deployment/version IDs, traffic state, public binding classifications and non-target binding digest.

Both PASS and STOP paths emit explicit zero-mutation markers including:

- `WORKER_UPLOAD=NO`
- `WORKER_DEPLOY=NO`
- `WORKER_CONFIG_MUTATION=NO`
- `D1_MUTATION=NO`
- `QUEUE_MUTATION=NO`
- `SECRET_VALUE_OBSERVED=NO`
- `SECRET_MUTATION=NO`
- `CLOUDFLARE_SETTINGS_MUTATION=NO`
- `RPI5_REQUEST=NO`
- `LIVE_AUTHORIZATION=NOT_GRANTED`

No Workers write credential or D1 credential is present in the workflow. There is no Wrangler mutation command, D1 query, Queue action, secret read/value export, route/domain/trigger mutation, Cloudflare account/settings mutation or RPi5 action.

## Source versus production state

This issue proves only that the repository contains a reviewed verifier. It does not prove that production Worker activation has occurred, that a particular deployment/version is currently active, or that verification-key/ingest state is live. Those claims require a future separately initiated GET-only verifier run against fresh production evidence.
