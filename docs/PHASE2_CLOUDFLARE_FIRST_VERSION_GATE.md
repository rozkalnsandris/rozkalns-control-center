# Phase 2 Cloudflare first-bootstrap gate

Issue: #59  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration

## Purpose

Prepare a source-controlled, fail-closed controller for the **later separately authorized first `rozkalns-control` Cloudflare Worker bootstrap**.

The first live attempt proved that `wrangler versions upload` cannot create a Worker that does not yet exist. Cloudflare's supported Wrangler flow requires an initial `wrangler deploy`; later versions can then use `wrangler versions upload` without traffic deployment.

This corrected gate therefore performs one **initial deployment with no public routing**, rather than incorrectly describing the bootstrap as a non-deployed first version.

The source task itself does not create or deploy a Worker.

## Platform semantics rechecked

Current Cloudflare documentation confirms:

- `wrangler deploy` creates a Worker version and immediately creates a deployment;
- Cloudflare's gradual-deployments flow performs an initial deploy before using `wrangler versions upload` for later undeployed versions;
- `workers_dev=false` prevents the Worker from being published on the account `*.workers.dev` subdomain when no routes are configured;
- `preview_urls=false` explicitly disables version Preview URLs;
- `wrangler deploy --secrets-file` can upload required secrets alongside code;
- `Workers Scripts Read` is sufficient for read-only verification;
- `Workers Scripts Write` authorizes the single initial Worker deployment;
- the List Versions API is paginated (`V4PagePagination`) and its collection is returned under the response `result.items`; the first item is the latest version;
- automatic draft resource provisioning is enabled by default in current Wrangler, so this gate explicitly disables experimental provisioning and auto-create;
- `secrets.required` in `wrangler.jsonc` remains the source of truth for required secret names.

A truly **first non-deployed version** is not a supported Wrangler bootstrap when the target Worker is absent. The supported least-exposure bootstrap is a **first non-routable deployment**.

## Exposure contract

`wrangler.jsonc` must keep all of the following true before apply:

```json
{
  "workers_dev": false,
  "preview_urls": false
}
```

The configuration must not contain `route`, `routes`, custom-domain configuration or trigger configuration for this gate.

The initial deployment therefore exists in Cloudflare's deployment model but has no configured `workers.dev`, Preview URL, route or custom domain exposure.

## Controller

Run without arguments:

```text
npm run cf:first-version-gate
```

Default output is plan-only and must include:

```text
MODE=PLAN
CLOUDFLARE_MUTATION=NO
AUTHORIZED_APPLY_CREATES_INITIAL_DEPLOYMENT=YES
PUBLIC_ROUTING=NO
WORKERS_DEV=DISABLED
PREVIEW_URLS=DISABLED
```

The controller does not read credentials or contact Cloudflare in plan mode.

## Future live prerequisites

A future owner-authorized apply requires all of the following at the same time:

1. a clean local checkout on branch `main`;
2. local `HEAD` and freshly fetched `origin/main` equal to the owner-authorized exact SHA;
3. dependencies installed from the lockfile and full `npm run check` passing;
4. a short-lived `Workers Scripts Read` account token for before/after verification;
5. a **separate** short-lived `Workers Scripts Write` account token for the single initial deployment;
6. `CLOUDFLARE_ACCOUNT_ID` for the intended account;
7. a local mode-0600 GitHub App private-key PEM file corresponding to an active GitHub App public-key record;
8. the exact one-shot owner authorization string.

The read and write Cloudflare tokens must be different. Token values must never be placed in Git, screenshots, chat, command-line arguments or logs.

## Exact future owner authorization

The corrected apply path accepts only:

```text
authorize Phase 2 Cloudflare first non-routable bootstrap <exact-main-sha>
```

The exact SHA must match both local `HEAD` and freshly fetched `origin/main`. If `main` moves, the authorization is stale and apply stops before any Cloudflare write.

The previous authorization form:

```text
authorize Phase 2 Cloudflare first non-deployed version <sha>
```

is obsolete and must never authorize this corrected gate.

## Apply boundary

The controller's only Cloudflare write is the repository-pinned Wrangler equivalent of:

```text
wrangler deploy
```

with:

- fixed Worker name `rozkalns-control`;
- `workers_dev=false` and `preview_urls=false` from source-controlled configuration;
- no route/custom-domain configuration;
- `--strict`;
- automatic provisioning disabled;
- auto-create disabled;
- skill installation disabled;
- a temporary `--secrets-file` containing only `GITHUB_APP_PRIVATE_KEY_PEM`.

The private-key value is copied to a temporary mode-0600 JSON file immediately before deploy and that temporary directory is removed in a `finally` cleanup path. The controller never prints the PEM or either Cloudflare token.

No follow-up `versions deploy`, route deployment, trigger deployment or standalone secret mutation is implemented.

## Pre-write fail-closed checks

Apply stops before deploy when any of these is true:

- expected SHA is malformed;
- branch is not `main`;
- worktree is dirty;
- local `HEAD` differs from the authorized SHA;
- freshly fetched `origin/main` differs from the authorized SHA;
- the owner authorization string differs by any character;
- Cloudflare account id/read token/write token is absent;
- read and write token values are the same;
- the target Worker already exists;
- the private-key file is missing, not a regular file, group/world accessible, or not a supported private-key PEM;
- repository checks or repo-pinned Wrangler validation fail.

## Post-deploy proof

After the initial deploy, the controller uses only the read token and requires:

- `rozkalns-control` is present in Worker inventory;
- the paginated List Versions result contains an `items` array;
- exactly one Worker version exists;
- that version has a non-empty id;
- exactly one deployment exists;
- that deployment points 100% at the one first version;
- Worker `workers.dev` subdomain is disabled;
- Worker Preview URLs are disabled;
- the first version exposes a `GITHUB_APP_PRIVATE_KEY_PEM` secret binding by name/type only, never by value.

Malformed/missing version pagination, an unexpected version count or a missing version id fail closed with distinct sanitized controller errors.

Successful bounded evidence is limited to non-secret metadata such as version id and:

```text
INITIAL_DEPLOYMENTS=1
WORKERS_DEV=DISABLED
PREVIEW_URLS=DISABLED
PUBLIC_ROUTING=NO
PRIVATE_KEY_BINDING=PROVEN
```

If the deploy succeeds but post-verification fails, the controller prints `POST_DEPLOY_STATE=REVIEW_REQUIRED` and stops. It does **not** attempt automatic rollback, route mutation or deletion.

## Failed first attempt evidence

The previous live attempt on `main=e8bb5e58719b10552c45948a6cdceff9a2f0af11` reached `wrangler versions upload` only after exact-main/token/private-key preflight and full repository checks. Wrangler rejected the operation because the Worker did not yet exist and instructed that `deploy` must be run first.

Read-only inventory immediately before that attempt showed `TARGET_WORKER_PRESENT=NO`. Therefore the failed attempt created no Worker version or deployment and the previous owner authorization is not reusable for this corrected write boundary.

## Successful live bootstrap evidence

The separately authorized corrected bootstrap on exact `main=0c2aec41e3eaa8c76c8a4a17ab4043097ada6a5e` successfully uploaded the Worker, assets and required secret binding. Wrangler reported version `38819190-ab13-4865-8976-7b5f7d1c1966` before the controller stopped in post-verification.

The stop was a controller parser defect, not a failed Cloudflare write: the controller assumed the List Versions `result` was a direct array, while the live and documented paginated API returns the collection under `result.items`.

An independent read-only reconciliation immediately after the stop proved:

- Worker present: yes;
- version count: exactly one;
- version id: `38819190-ab13-4865-8976-7b5f7d1c1966`;
- deployment count: exactly one;
- deployment allocation: 100% to that one version;
- `workers.dev`: disabled;
- Preview URLs: disabled;
- `GITHUB_APP_PRIVATE_KEY_PEM`: exactly one `secret_text` binding.

After that proof, the local GitHub App private-key PEM was removed successfully. The corresponding GitHub App public-key record must remain active while Cloudflare uses the bound private key.

The bootstrap must **not** be repeated: the target Worker now exists, and the controller's pre-write `TARGET_ALREADY_EXISTS` guard must continue to stop any accidental first-bootstrap rerun. The parser correction is source-only and requires no additional Cloudflare write.

## Forbidden scope

This gate does not authorize or implement:

- any route/custom domain or `workers.dev` exposure;
- Preview URLs;
- a second deployment or gradual traffic shift;
- `wrangler versions upload` during first bootstrap;
- standalone secret put/delete operations;
- webhook activation;
- D1, Queue/DLQ, KV, R2 or other live resource creation;
- GitHub write permissions or mutations;
- RPi5, DB, host/root or production changes.

## Deploy impact

`DEPLOY_REQUIRED=no` for this source-only correction.

The live first bootstrap is already complete and independently verified. This parser correction must not perform or authorize another Cloudflare deployment.
