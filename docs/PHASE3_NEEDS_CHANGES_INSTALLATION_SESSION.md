# Phase 3 — least-privilege Needs changes installation session

Issue: #211

## Purpose

This slice adds the GitHub App installation-session boundary needed by the already-merged guarded `Needs changes` / `REQUEST_CHANGES` decision contract.

It remains source-only. It does **not** change the installed GitHub App permissions, does not mint a production write token, and does not wire a Worker POST route or UI action.

## GitHub contract

GitHub's current installation-token API allows a token request to be narrowed by both repository and permission. The review-create endpoint accepts GitHub App installation access tokens and requires `Pull requests: write`.

For this action the requested token body is therefore exactly:

```json
{
  "repositories": ["<one managed repository name>"],
  "permissions": {
    "pull_requests": "write"
  }
}
```

No token is requested without explicit repository restriction or without an explicit permissions object.

GitHub installation access tokens expire after about one hour. The token bytes are treated as opaque: the code has no 40-character assumption and no `ghs_` prefix assumption. This is required because GitHub began rolling out a new stateless installation-token format in 2026.

## Scope boundary

The new provider accepts:

- one fixed installation id supplied by later runtime assembly;
- one managed repository;
- exactly the logical capability `pull_requests:write`;
- an observation timestamp.

It mints one short-lived token and returns a narrowly typed session that can perform only:

`POST https://api.github.com/repos/<same managed repo>/pulls/<positive integer>/reviews`

with:

- GitHub REST API version `2026-03-10`;
- `Accept: application/vnd.github+json`;
- `Content-Type: application/json`;
- `redirect: manual`;
- required permission `pull_requests:write`;
- an exact `REQUEST_CHANGES` body containing a 40-hex `commit_id`.

The caller cannot supply an Authorization header. The session inserts the installation token internally.

## Returned token evidence

The token exchange must return exactly one repository matching the requested managed repository.

The returned permission evidence must contain `pull_requests: write`. The only tolerated additional permission evidence is `metadata: read`, because GitHub may include repository metadata read evidence with an installation token. Any other returned permission is rejected as scope expansion.

The lease must:

- expire after issuance;
- retain at least 60 seconds of usable lifetime when acquired;
- not exceed the existing short-lived installation-token lifetime bound.

Raw token bytes never appear in the lease or error messages.

## One-shot behavior

The authorized write session is one-shot. Once its `execute()` method starts the outbound review request, a second call on the same session is rejected locally.

This complements #209/#210's higher-level idempotency rules. It does not make an HTTP write intrinsically idempotent; it simply prevents accidental reuse of the same credential session inside this boundary.

Unknown outcome handling remains owned by the guarded decision/writer layer: no blind retry is added here.

## Existing read-only contract remains unchanged

The Phase 2 installation read scope continues to accept only `read` permission values. This slice deliberately adds a separate write-session module instead of widening `GitHubInstallationReadScope` or the existing dashboard/read session.

Therefore normal dashboard/reconciliation sessions remain read-only by construction.

## Not activated

This slice does not add any of the following:

- Worker mutation route;
- UI `Needs changes` activation;
- D1 audit/idempotency persistence;
- write-capable Cloudflare runtime assembly;
- GitHub App permission change;
- production Worker binding/config change;
- production deployment;
- live GitHub review write;
- merge capability or `Contents: write`.

## Later activation order

A later campaign must remain owner-gated and proceed in separate reviewed steps:

1. implement durable D1 audit/idempotency storage for the #210 decision contract;
2. compose Access-authenticated Worker POST handling without yet granting GitHub write permission;
3. prepare a read-only GitHub App permission preflight showing the exact current vs requested permission delta;
4. obtain separate owner authorization before changing the GitHub App from pull-request read to pull-request write;
5. verify the installation accepts the permission change and that no broader repository permission was added;
6. only then deploy a write-capable runtime under a separate production-deploy authorization;
7. run a bounded canary on an explicitly selected test PR/head and reconcile the resulting review exactly once.

Merge of this source slice authorizes none of steps 3–7.

**Production deploy: NO.**
