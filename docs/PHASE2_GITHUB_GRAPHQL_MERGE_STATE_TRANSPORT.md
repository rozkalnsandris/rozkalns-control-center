# Phase 2 GitHub GraphQL merge-state transport

Issue: #37  
PR: #39  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration, source-only GraphQL correctness boundary

## Purpose

Define the only GraphQL operation currently allowed inside the Rozkalns Control GitHub integration: a bounded read of one pull request's merge-state fields already consumed by the Phase 2 mapper.

This remains source-only. It does not create/install the real GitHub App, grant permissions, bind a private key, mint a live credential, call GitHub from the Worker or deploy Cloudflare.

## Official GitHub semantics rechecked 2026-08-11

The implementation follows the current GitHub GraphQL contract:

- a GitHub App installation token can authenticate GraphQL requests;
- the GitHub.com GraphQL endpoint is fixed at `https://api.github.com/graphql`;
- normal GraphQL query/mutation operations use HTTP `POST` with a JSON body containing `query`;
- variables are the supported way to pass dynamic values without changing the query document;
- GraphQL queries are reads, while mutations perform modifications;
- GitHub App GraphQL permission sufficiency must be tested against the intended real query instead of inferred only from documentation;
- GraphQL rate-limit response headers expose limit, remaining, used, reset and resource evidence;
- GraphQL primary rate-limit exhaustion may return HTTP 200 with a GraphQL error and remaining=0;
- secondary limiting may return 200 or 403 and may provide `retry-after`;
- repeated calls while limited must not be used as a tight retry strategy.

The current PullRequest schema continues to expose the fields used by Control: `number`, `headRefOid`, `mergeable`, `mergeStateStatus` and `isDraft`.

## Fixed operation boundary

The source owns one named query document:

```graphql
query ControlPullRequestMergeState($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      headRefOid
      mergeable
      mergeStateStatus
      isDraft
    }
  }
}
```

Dynamic values are restricted to exactly three variables:

- repository owner;
- repository name;
- positive pull-request number.

The caller cannot supply or alter the query document, operation name, endpoint, method, media type or redirect policy.

There is no generic GraphQL executor in the Phase 2 public contract.

## Scope validation

Before credential acquisition:

1. parse the existing `GitHubInstallationReadScope`;
2. resolve the requested repository through managed-project policy;
3. require that repository to be present in the credential scope;
4. require `pull_requests: read` in the requested scope;
5. require a positive safe-integer pull-request number;
6. derive owner/name only from the canonical managed repository identity.

Unknown, disabled, excluded or out-of-scope repositories fail before session acquisition.

The source contract does **not** claim that `pull_requests: read` has already been proven sufficient for the eventual real GitHub App GraphQL query. GitHub's current guidance is to test GraphQL App permissions. That live permission canary remains a separately authorized rollout step.

## Credential/session boundary

`app-installation-session.ts` now reuses one private installation-credential acquisition path for two separate narrow sessions:

- the existing REST GET session;
- the new fixed GraphQL merge-state query session.

The REST session interface remains GET-only and is not widened to GraphQL or POST.

The GraphQL session validates the entire fixed request envelope again before adding the installation credential internally. It sends only:

- fixed GraphQL endpoint;
- `POST`;
- JSON request body containing the fixed operation/query and exact variables;
- `Accept: application/json`;
- `Content-Type: application/json`;
- `Authorization: Bearer <opaque installation credential>` inside the integration closure;
- manual redirect policy.

The raw installation credential is not returned in lease evidence, transport results or public errors.

## Response contract

Only HTTP 200 proceeds to GraphQL envelope parsing after rate-limit/status validation.

The response must be JSON. Control then requires:

```text
object
  data: object
    repository: object
      pullRequest: object
```

`repository: null` or `pullRequest: null` is a typed missing-resource outcome.

The pull-request object is passed through the existing fail-closed `mapGitHubGraphqlPullRequestMergeState()` mapper. The mapped pull number must exactly equal the requested pull number.

The higher-level authoritative snapshot contract remains responsible for binding returned merge-state evidence to the REST-observed PR head SHA and draft state.

## GraphQL errors and partial data

GraphQL can return both `data` and `errors` in one response. Rozkalns Control never treats partial data as decision-grade evidence.

If an `errors` field is present, it must be a non-empty array and the request fails closed even when apparently usable `data` is also present.

Remote GraphQL messages, paths or upstream details are not copied into public error strings.

## Rate-limit handling

The transport parses only sanitized headers:

- `x-ratelimit-limit`;
- `x-ratelimit-remaining`;
- `x-ratelimit-used`;
- `x-ratelimit-reset`;
- `x-ratelimit-resource`, which must be `graphql` when present;
- `retry-after` when present.

Primary limit exhaustion is recognized even on HTTP 200 when remaining is zero. Retry-not-before is derived from reset evidence.

Secondary limiting with `retry-after` exposes only the computed retry-not-before timestamp. A 429 fallback remains fail-safe with a one-minute minimum local boundary.

There is no sleep or automatic retry loop.

## Failure taxonomy

Fixed typed outcomes cover:

- invalid request/scope;
- credential session unavailable/unusable;
- transport failure;
- rate limited;
- unauthorized;
- forbidden;
- GraphQL error envelope;
- repository/PR missing;
- malformed headers/content/envelope/mapper output;
- unexpected HTTP status.

Failures are intentionally sanitized and never contain token/JWT, remote response body, signer detail or network exception text.

## Regression evidence

Deterministic tests prove:

- exact operation/query/variables;
- exact managed-repository and `pull_requests: read` scope gate;
- successful mapper composition;
- sanitized GraphQL rate-limit evidence;
- HTTP-200 primary-limit handling;
- `retry-after` secondary-limit handling with one request only;
- partial `data + errors` rejection;
- 401/403/unexpected status mapping;
- missing repository/PR rejection;
- malformed content/envelope/header rejection;
- mismatched returned PR number rejection;
- credential/session/transport error sanitization;
- concrete #32 credential acquisition + GraphQL session composition;
- query/repository tampering rejection before authenticated GraphQL HTTP;
- existing REST session regressions remain green;
- Worker/shared source still has no GraphQL endpoint/auth/mutation path.

Source/test CI #99 (`31537064729`) passed repository policy, public-repo safety, runtime dependency audit, typecheck, typed lint, all unit tests, Worker/SPA build and Wrangler dry-run before this documentation reconciliation.

## RPi5 and rollout boundary

`RPi5_main#163` is complete. Current RPi5 #140 remains waiting for a genuinely newer exact-current-main CV delta that independently classifies `AUTO_DEPLOY_SAFE` with `CONTROL_PLANE_CHANGED=false` before any separately authorized one-shot controller canary.

This source-only task does not create production authorization in either project.

A future live Control rollout must separately authorize and prove:

1. real dedicated `Rozkalns Control` App installation;
2. exact selected repositories;
3. the current staged permission set;
4. a real GraphQL merge-state permission canary;
5. approved private-key/signer secret binding;
6. runtime provider wiring;
7. the then-current RPi5 sequencing state.

## Deploy impact

`DEPLOY_REQUIRED=no`.
