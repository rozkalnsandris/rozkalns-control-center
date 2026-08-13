# Phase 2 Cloudflare first-version gate

Issue: #59  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration

## Purpose

Prepare a source-controlled, fail-closed controller for the **later separately authorized** first `rozkalns-control` Cloudflare Worker version. This source task does not create a Worker, upload a version, configure a secret value, create a deployment, or move traffic.

The controller is intentionally a one-time bootstrap gate. It refuses to apply if a `rozkalns-control` Worker already exists.

## Platform semantics rechecked

Current Cloudflare documentation confirms:

- `wrangler versions upload` uploads a Worker version without deploying that version to traffic;
- the same command accepts `--secrets-file`, so the first code version and required secret can be created in one version upload;
- `wrangler secret put` creates a version and deploys it immediately, so it is forbidden for this gate;
- `wrangler versions deploy` is the separate traffic-deployment operation and is forbidden for this gate;
- `Workers Scripts Read` is sufficient for read-only verification;
- `Workers Scripts Write` authorizes Worker script/version writes;
- automatic draft resource provisioning is enabled by default in current Wrangler, so this gate explicitly disables experimental provisioning and auto-create;
- `secrets.required` in `wrangler.jsonc` remains the source-of-truth for required secret names and fails future version uploads when the required secret is absent.

## Controller

Run without arguments:

```text
npm run cf:first-version-gate
```

Default output is plan-only and must state:

```text
MODE=PLAN
CLOUDFLARE_MUTATION=NO
TRAFFIC_DEPLOYMENT=NO
```

The controller does not read credentials or contact Cloudflare in plan mode.

## Future live prerequisites

A future owner-authorized apply requires all of the following at the same time:

1. a clean local checkout on branch `main`;
2. local `HEAD` and freshly fetched `origin/main` equal to the owner-authorized exact SHA;
3. dependencies installed from the lockfile and full `npm run check` passing;
4. a short-lived `Workers Scripts Read` account token for before/after verification;
5. a **separate** short-lived `Workers Scripts Write` account token for the single version upload;
6. `CLOUDFLARE_ACCOUNT_ID` for the intended account;
7. a local mode-0600 GitHub App private-key PEM file corresponding to an active GitHub App public-key record;
8. the exact one-shot owner authorization string.

The read and write Cloudflare tokens must be different. Token values must never be placed in Git, screenshots, chat, command-line arguments or logs.

If no usable GitHub App private key exists locally at live time, generating a new GitHub App key is a **separate explicit GitHub App mutation gate**. The generated public-key record must remain active after the private key is stored in Cloudflare. The local PEM should be destroyed only after successful post-upload verification.

## Exact future owner authorization

The apply path accepts only:

```text
authorize Phase 2 Cloudflare first non-deployed version <exact-main-sha>
```

The exact SHA must match both local `HEAD` and freshly fetched `origin/main`. If `main` moves, the authorization is stale and apply stops before any Cloudflare write.

## Apply boundary

The controller's only Cloudflare write is the repository-pinned Wrangler equivalent of:

```text
wrangler versions upload
```

with strict mode, automatic provisioning disabled, auto-create disabled, the fixed Worker name `rozkalns-control`, and a temporary `--secrets-file` containing only `GITHUB_APP_PRIVATE_KEY_PEM`.

The private-key value is copied to a temporary mode-0600 JSON file immediately before upload and that temporary directory is removed in a `finally` cleanup path. The controller never prints the PEM or either Cloudflare token.

The controller intentionally contains no traffic deployment command and no standalone secret mutation command.

## Pre-write fail-closed checks

Apply stops before upload when any of these is true:

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
- repo-pinned Wrangler/full repository checks fail.

## Post-upload proof

After a successful version upload, the controller uses only the read token and requires:

- `rozkalns-control` is now present in Worker inventory;
- exactly one Worker version exists for the first-version bootstrap;
- the version has an id;
- deployment count is exactly zero.

It then prints only non-secret evidence including the version id and `ACTIVE_DEPLOYMENTS=0`.

If upload succeeds but post-upload verification fails, the controller prints `POST_UPLOAD_STATE=REVIEW_REQUIRED` and stops. It does **not** attempt an automatic rollback or deletion. Because no deployment is authorized, the safe response is to leave the undeployed version untouched and inspect it under a new explicit mutation decision.

## Forbidden scope

Issue #59 does not authorize or implement:

- traffic deployment or percentage rollout;
- Worker route/domain/trigger changes;
- standalone secret put/delete operations;
- webhook activation;
- D1, Queue/DLQ, KV, R2 or other live resource creation;
- GitHub write permissions or mutations;
- RPi5, DB, host/root or production changes.

## Deploy impact

`DEPLOY_REQUIRED=no` for issue #59 itself.

Merging the source controller does not authorize its apply mode. First Worker/version creation remains a separately scoped owner authorization after merge and exact-main CI.
