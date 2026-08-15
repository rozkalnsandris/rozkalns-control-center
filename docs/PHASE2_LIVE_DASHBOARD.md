# Phase 2 live GitHub dashboard snapshot

## Purpose

This boundary converts bounded GitHub App installation reads into the normalized Control dashboard model. It is read-only and is not an authorization source for merge or deployment actions.

## Source boundary

The dashboard reads exactly the repositories selected by `managedProjectPolicies`. The production dashboard acquires one short-lived installation token scoped to exactly those six repositories at the already-approved `actions` rollout stage: Metadata, Contents, Issues, Pull requests, Checks and Actions are read-only. Commit statuses and Administration are not requested.

One canonical UTC observation time is created by the Worker route and reused for every repository and every PR in that snapshot. A failure in any managed repository fails the entire live snapshot closed; partial live truth is not presented as complete.

The server returns only `ControlDashboardData`. Raw GitHub payloads, installation credentials, rate-limit bodies and upstream errors are never exposed to the browser.

## Bounded GitHub fan-out

Cloudflare Workers Free allows 50 external subrequests per Worker invocation. The live dashboard must remain materially below that boundary rather than relying on a paid-plan limit.

The dashboard therefore uses one exact-six-repository installation-token exchange followed by one fixed GraphQL repository snapshot per managed repository. The hard source contract is seven external GitHub subrequests for a complete six-repository dashboard request: one token exchange plus six GraphQL reads.

Each repository GraphQL snapshot includes its default-branch commit, open issues, open pull requests, changed-file count, draft/merge state, latest reviews, exact-head check runs and associated Actions workflow-run evidence. Connections are capped at 100 items and any `hasNextPage=true` result fails the complete dashboard snapshot closed instead of silently presenting partial evidence or issuing unbounded pagination requests.

A regression test requires the complete dashboard path to remain below the Free-plan budget. Adding a new external GitHub call to the dashboard therefore requires an explicit budget review rather than silently increasing fan-out.

## Conservative classification

The live dashboard is observational until branch-policy evidence becomes complete enough for authoritative projection.

- any latest effective exact-head Check Run or workflow failure -> `CI_FAILED`;
- latest effective review state containing `CHANGES_REQUESTED` -> `NEEDS_ANDRIS`;
- draft, running, missing, ambiguous or otherwise non-authoritative readiness -> `WAITING`;
- observational snapshots never emit `MERGE_READY`;
- `allowedActions` is exactly `OPEN_PR` for a live PR.

An observed green CI state is useful evidence, but it is not sufficient to claim merge readiness when required-check/review/branch-policy coverage is incomplete.

## Credential/session behavior

The bounded dashboard token is requested for exactly the six selected repositories and exactly the already-approved read permissions. The existing token exchange contract still validates returned repository and permission evidence fail closed. The raw installation credential remains private to the request-scoped session and is never stored in D1, source, logs or browser state.

The narrow `/api/github/reconcile` path keeps its existing one-repository REST/GraphQL session model. Dashboard batching does not broaden that reconciliation contract and does not broaden GitHub App permissions.

## Worker route

`GET /api/github/dashboard`

- accepts no query parameters;
- is guarded by the existing `CONTROL_LIVE_READ_ENABLED` flag in the Worker entrypoint;
- returns `Cache-Control: no-store`;
- sanitizes upstream failures to a fixed `LIVE_DASHBOARD_FAILED` error;
- performs no GitHub or Cloudflare mutation.

## UI contract

The React client performs one hoisted dashboard request rather than per-card requests. Live mode renders the same mobile-first normalized model as fixtures. A real PR URL is navigation and must be rendered as an anchor; evidence disclosure remains native `<details>/<summary>`.

Production activation or redeployment remains a separate explicit owner authorization after source merge and exact-main CI. This source boundary does not authorize a production deploy.
