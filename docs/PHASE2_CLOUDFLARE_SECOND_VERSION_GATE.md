# Phase 2 Cloudflare second non-deployed version gate

This runbook prepares the first post-bootstrap source upload for the existing `rozkalns-control` Worker. It is intentionally narrower than a deployment canary: the apply path may create exactly one additional Worker version, but it must not create or modify an active traffic deployment.

## Why this gate exists

The first-bootstrap flow is complete and must not be repeated. The live Worker currently has the known bootstrap version `38819190-ab13-4865-8976-7b5f7d1c1966`, one deployment at 100% to that version, workers.dev disabled and Preview URLs disabled. Source now contains the reviewed read-only `GET /api/github/reconcile` route, but the live Worker has not received that source yet.

Cloudflare documents `wrangler versions upload` as a version creation operation that does not deploy the version immediately. `wrangler versions deploy` is a separate traffic deployment action. Cloudflare also documents that required existing secrets are validated during version upload and secrets omitted from a new upload are preserved from the previous version.

## Plan mode

Run:

```bash
npm run cf:second-version-gate
```

Plan mode is credential-free, network-free and mutation-free. It prints the expected existing Worker baseline, the exact owner-authorization format and the invariant that traffic deployment remains `NO`.

## Live apply prerequisites

All of these must be true at the same time:

- exact clean local `main` equals the separately authorized SHA;
- fresh `origin/main` equals the same SHA;
- full `npm run check` passes on that exact checkout;
- the Worker exists;
- the version inventory contains exactly the known bootstrap version and no second version yet;
- exactly one active deployment exists and points 100% to the bootstrap version;
- workers.dev is disabled;
- Preview URLs are disabled;
- the bootstrap version contains the `GITHUB_APP_PRIVATE_KEY_PEM` secret binding;
- source `wrangler.jsonc` keeps `workers_dev=false`, `preview_urls=false` and contains no route/routes/triggers/custom-domain configuration;
- separate short-lived Cloudflare account tokens are supplied for Workers Scripts Read and Workers Scripts Write;
- the owner gives the exact one-shot authorization:

```text
authorize Phase 2 Cloudflare second non-deployed version upload <exact-main-sha>
```

Tokens must never be placed in CLI arguments, logs, issue comments or chat. The local GitHub App private key is not required and must not be regenerated for this gate.

## The only authorized write

The controller invokes the repository-pinned Wrangler with:

```text
versions upload --name rozkalns-control --strict
```

Experimental provisioning, automatic resource creation and skill installation are explicitly disabled. The controller does not pass a secrets file because the required secret already exists and Cloudflare preserves omitted secrets from the previous version.

The controller never invokes `wrangler deploy`, `wrangler versions deploy`, trigger deployment, Preview URL aliases or secret mutation commands.

## Required post-verify

After the version upload, read-only verification must prove all of the following:

- exactly two Worker versions exist;
- the original bootstrap version still exists;
- exactly one distinct new version exists and has an ID;
- the new version contains the `GITHUB_APP_PRIVATE_KEY_PEM` secret binding;
- exactly one active deployment still exists;
- its deployment ID is unchanged from prewrite;
- it still points 100% to the bootstrap version;
- workers.dev remains disabled;
- Preview URLs remain disabled.

A successful controller ends with evidence including:

```text
APPLY=PASS
VERSION_COUNT=2
DEPLOYMENT_UNCHANGED=YES
TRAFFIC_DEPLOYMENT=NO
WORKERS_DEV=DISABLED
PREVIEW_URLS=DISABLED
PUBLIC_ROUTING_CHANGE=NO
PRIVATE_KEY_BINDING=PROVEN_ON_NEW_VERSION
```

If the upload succeeds but any postverify fails, the controller prints `POST_UPLOAD_STATE=REVIEW_REQUIRED` and stops. Do not retry, delete a version, create a deployment or alter routing until the live state has been reconciled read-only.

## Explicitly not authorized by this gate

This gate does not authorize traffic deployment, gradual rollout, version preview exposure, workers.dev, routes/custom domains, Cloudflare Access, webhook activation, D1, Queue/DLQ, GitHub write permission, RPi5 mutation or production deployment.
