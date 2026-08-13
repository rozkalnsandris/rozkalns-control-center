# Phase 2 read-only Worker reconciliation route

Issue #63 introduces the first source-level Worker boundary that can compose the already-reviewed Cloudflare GitHub App runtime with authoritative reconciliation.

## Route contract

`GET /api/github/reconcile?repository=<managed-repo>&issue=<positive-int>&pull=<positive-int>`

The route accepts exactly those three query keys once each. Repository identity must resolve through the existing managed-project read policy before any live GitHub runtime is created. Issue and pull request numbers must be positive safe integers.

One server-generated observation timestamp is used for the repository runtime context and the authoritative reconciliation call. Commit-status evidence is explicitly `NOT_REQUESTED` because the steady-state GitHub App does not have `Commit statuses: read`; deploy impact remains `UNKNOWN`.

The response is only the normalized `BLOCKED` or `PROJECTED` authoritative reconciliation result and is always `Cache-Control: no-store`. Raw GitHub payloads, JWTs, installation tokens, private-key material and remote error bodies are not returned.

Current branch-policy runtime evidence uses the Metadata active-rules reader only, so policy coverage remains `PARTIAL` unless a separately reviewed complete policy source exists. A `BLOCKED` result is therefore an expected fail-closed outcome and must not be treated as merge readiness.

## Security boundary

The Worker route does not own GitHub credentials or arbitrary HTTP. App JWT issuance, short-lived installation-token exchange, repository/permission narrowing and REST/GraphQL transports remain inside `src/integrations/github`. The route adds no GitHub mutation method, webhook handling, D1/Queue binding, Cloudflare Access behavior, RPi5 path or AI runtime.

## Deployment boundary

This source change does not update the already-created Cloudflare Worker. Merge does not authorize a new Worker version/deployment, route/custom-domain exposure, workers.dev, Preview URLs or any production rollout. Any live canary of this route requires a separate owner-authorized Cloudflare version/deployment/access plan tied to the then-current exact `main` SHA.
