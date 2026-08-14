# Phase 2 live GitHub dashboard snapshot

## Purpose

This boundary converts bounded GitHub App installation reads into the normalized Control dashboard model. It is read-only and is not an authorization source for merge or deployment actions.

## Source boundary

The dashboard reads exactly the repositories selected by `managedProjectPolicies`. Each repository gets an exact one-repository GitHub App installation scope at the already-approved `actions` rollout stage: Metadata, Contents, Issues, Pull requests, Checks and Actions are read-only. Commit statuses and Administration are not requested.

One canonical UTC observation time is created by the Worker route and reused for every repository and every PR in that snapshot. A failure in any managed repository fails the entire live snapshot closed; partial live truth is not presented as complete.

The server returns only `ControlDashboardData`. Raw GitHub payloads, installation credentials, rate-limit bodies and upstream errors are never exposed to the browser.

## Conservative classification

The live dashboard is observational until branch-policy evidence becomes complete enough for authoritative projection.

- any latest effective exact-head Check Run or workflow failure -> `CI_FAILED`;
- latest effective review state containing `CHANGES_REQUESTED` -> `NEEDS_ANDRIS`;
- draft, running, missing, ambiguous or otherwise non-authoritative readiness -> `WAITING`;
- observational snapshots never emit `MERGE_READY`;
- `allowedActions` is exactly `OPEN_PR` for a live PR.

An observed green CI state is useful evidence, but it is not sufficient to claim merge readiness when required-check/review/branch-policy coverage is incomplete.

## Credential/session behavior

The Cloudflare request runtime memoizes installation sessions by exact installation id, repository scope, permission set and observation time. REST reads for one repository therefore reuse one short-lived installation session within the dashboard request instead of exchanging a new installation token for every endpoint call. GraphQL uses an independently memoized session with the same exact repository scope. Failed acquisition is evicted rather than cached.

The cache is request-scoped because `createCloudflareGitHubReadRuntime()` is created inside the Worker request executor. No raw credential is persisted to D1, source, logs or browser state.

## Worker route

`GET /api/github/dashboard`

- accepts no query parameters;
- is guarded by the existing `CONTROL_LIVE_READ_ENABLED` flag in the Worker entrypoint;
- returns `Cache-Control: no-store`;
- sanitizes upstream failures to a fixed `LIVE_DASHBOARD_FAILED` error;
- performs no GitHub or Cloudflare mutation.

## UI contract

The React client performs one hoisted dashboard request rather than per-card requests. Live mode renders the same mobile-first normalized model as fixtures. A real PR URL is navigation and must be rendered as an anchor; evidence disclosure remains native `<details>/<summary>`.

Production remains fixture-only while `CONTROL_LIVE_READ_ENABLED=false`. Enabling live reads is a separate production authorization after this source change is merged and exact-main CI is successful.
