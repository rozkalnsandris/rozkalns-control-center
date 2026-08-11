# Phase 2 GitHub REST read transport

Issue: #30  
PR: #31  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration, source-only transport implementation

## Purpose

Define the concrete source-level GitHub REST read transport that sits beneath `GitHubInstallationReadTransport` without activating a live GitHub App, minting credentials, wiring a Worker route, or changing production resources.

The transport is intentionally narrower than a generic HTTP client. It exists to make the later live adapter inherit reviewed repository, permission, pagination, rate-limit and credential boundaries instead of inventing them at rollout time.

## Current external semantics

GitHub REST documentation was rechecked on 2026-08-11 before implementation.

The current contract relies on these documented semantics:

- REST pagination is communicated through the response `Link` header; `rel="next"` is followed instead of manually constructing later pages;
- pagination shape and `per_page` support are endpoint-specific, so the transport preserves pages rather than generically merging response bodies;
- authenticated integrations should avoid concurrent request bursts;
- rate-limit state is reported through `x-ratelimit-*` response headers;
- primary and secondary limiting may return `403` or `429`;
- `retry-after` is authoritative when present; when primary remaining capacity is zero, `x-ratelimit-reset` supplies the reset time;
- when a `429` response supplies neither retry timing signal, this transport exposes a conservative one-minute local retry floor rather than retrying immediately;
- current REST requests are version-pinned with `X-GitHub-Api-Version: 2026-03-10`;
- `Accept: application/vnd.github+json` remains the integration-owned media type.

These are reviewed external assumptions, not permanent platform guarantees. Re-check them again before a live rollout or API-version change.

## Boundary layering

### Existing contract

`app-installation-read-contract.ts` remains authoritative for:

- managed-repository scope;
- selected installation scope;
- approved Phase 2 read permissions;
- repository-bound relative REST paths;
- reviewed API version;
- sanitized credential-lease evidence;
- short-lived lease validation.

### New concrete transport

`rest-read-transport.ts` owns:

- fixed `https://api.github.com` origin;
- GET-only request envelopes;
- integration-owned media type and API version;
- manual redirect policy;
- canonical repository URL enforcement;
- sequential Link-driven pagination;
- pagination cycle detection;
- bounded request count;
- response content-type/JSON validation;
- sanitized rate-limit evidence;
- typed fail-closed transport outcomes.

### Future credential/session implementation

The transport accepts a narrow `GitHubInstallationAuthorizedReadSessionProvider` boundary. A later authorized implementation may own raw installation credentials internally and expose only:

- sanitized credential lease evidence;
- an authorized `execute()` operation that accepts the already-constrained GET envelope.

Raw tokens, JWTs, private keys and authorization-header strings are deliberately absent from the transport/domain contract, fixtures, logs and returned errors.

## Request invariants

Before the first authorized session is used, the transport revalidates:

1. observation time is parseable;
2. installation scope satisfies the existing contract;
3. request API version exactly matches the reviewed version;
4. managed repository is inside the installation scope;
5. required permission is explicitly read-only and granted in that scope;
6. REST path remains inside the named repository;
7. the resolved URL remains on the fixed GitHub HTTPS origin;
8. encoded path traversal cannot escape the repository boundary.

The caller cannot supply an arbitrary host, method, media type, API version override, redirect policy or authentication header.

## Pagination semantics

Pagination is sequential and evidence-driven:

- execute the first validated repository URL;
- parse the response `Link` header when present;
- follow at most one validated `rel="next"` URL;
- require each next URL to remain on the fixed origin and inside the same repository path boundary;
- reject malformed or duplicate next-link evidence;
- reject cycles before issuing a repeated request;
- stop when no `rel="next"` exists;
- fail closed before crossing the configured local request budget.

The default budget is 10 requests and the configuration itself cannot exceed the source-controlled hard cap of 100 requests.

The result preserves `pages: readonly T[]`. It does not concatenate arrays or merge wrapper objects because GitHub endpoints expose different payload shapes. Endpoint-specific adapters must normalize those pages explicitly through the existing fail-closed mappers.

## Rate-limit semantics

Successful responses may expose sanitized evidence:

- limit;
- remaining;
- used;
- reset time;
- resource bucket.

Malformed numeric/resource headers fail closed instead of being silently ignored.

For `403`/`429`:

1. valid `retry-after` produces `RATE_LIMITED` with a calculated retry-not-before time;
2. otherwise `remaining=0` requires a valid reset time and produces `RATE_LIMITED`;
3. otherwise bare `429` produces `RATE_LIMITED` with a conservative one-minute retry floor;
4. an ordinary non-rate-limited `403` remains `FORBIDDEN`.

The low-level transport never sleeps and never retries automatically. Queue/reconciliation policy may decide what to do with retry-not-before evidence later.

## Typed fail-closed outcomes

The current transport distinguishes:

- invalid request;
- credential session unavailable;
- credential lease unusable;
- low-level transport failure;
- rate limited;
- unauthorized;
- forbidden;
- not found;
- malformed response;
- pagination boundary violation;
- pagination cycle;
- pagination budget exhaustion;
- unexpected status.

Error messages are fixed/sanitized. Upstream credential-provider, network and response-body details are not copied into public error strings.

## Source-only safety boundary

This PR deliberately does **not** add:

- a live credential provider;
- GitHub App creation, installation or permission changes;
- JWT/private-key/installation-token minting;
- a Worker route that calls GitHub;
- GraphQL transport;
- webhook runtime wiring;
- D1/Queue/Workflow bindings;
- Cloudflare production resources or deployment;
- RPi5/DB/host mutation;
- GitHub write methods;
- AI execution.

`src/worker/index.ts` remains disconnected from the GitHub transport.

## Regression coverage

Deterministic fake-session tests cover:

- one-page reads;
- multiple pages;
- absent Link header;
- off-origin pagination;
- cross-repository pagination;
- encoded traversal;
- cycles;
- request-budget exhaustion;
- `401`, ordinary `403`, `404` and unexpected statuses;
- primary rate-limit reset evidence;
- secondary `retry-after` evidence;
- bare `429` conservative retry timing;
- malformed rate-limit/retry headers;
- malformed Link evidence;
- non-JSON successful responses;
- sanitized wrapping of credential-provider and network failures.

## Sequencing boundary

The branch started from exact post-PR-#29 `main` SHA:

`d414a34e04ffff36b904a4ab1562cc0025f5df71`

Current `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md` was re-read during this task. Its Phase 3 first incomplete production sequence is now issue #163: separately reconcile the exact classifier/control-plane baseline and then the production baseline before any future genuine-newer-SHA `AUTO_DEPLOY_SAFE` controller execution canary.

That RPi5 work is separate. Nothing in this source-only Control transport authorizes classifier installation, production reconciliation, timer activation, GitHub App rollout, credential changes or deployment.

## Deploy impact

`DEPLOY_REQUIRED=no`.

Merging this source/tests/docs work does not activate the transport in production.
