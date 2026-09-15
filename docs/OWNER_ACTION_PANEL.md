# Owner decision action panel

The canonical action vocabulary is `OPEN_PR`, `MERGE`, `NEEDS_CHANGES`, `LATER`,
`RETRY_CI`, `CONTINUE`, `PAUSE`. Refresh remains global. All actions are visible;
each unavailable/disabled state includes a visible, keyboard-associated reason.
The API validates the complete normalized `actionStates` vocabulary. React does
not consume raw GitHub payloads. Legacy domain `allowedActions` remains separate
to preserve deterministic Later fingerprints.

## Source behavior

- Open PR navigates only to the exact repository/PR URL.
- Merge and Needs changes retain their existing Worker authorization, audit,
  idempotency, exact-head/base and authoritative reconciliation implementations.
  Merge is squash only. Needs changes requires the review message.
- Later retains its existing persistence and material-state fingerprint; UI
  hydration never changes the action list used for the submitted fingerprint.
- Continue and Pause have authenticated preflight and POST routes at
  `/api/control/continuation/preflight` and `/api/control/continuation`.
  They operate only on an existing exact campaign. The preflight requires one
  unambiguous current-task/PR association; it never invents campaigns.
  Continue resumes flags and may reserve the existing planner's next eligible
  task. It does not start an agent or execute a task. Human gates and incomplete
  current tasks stop Continue. Pause changes continuation state and clears an
  unstarted reservation; current task and human gate remain unchanged.
- Both continuation mutations re-read durable state and authoritative GitHub
  evidence, compare main, and atomically compare every campaign/task field and
  the task count before persistence. A unique request ID binds actor and exact
  request; actor/request/result are audited. Same-request successful replay
  returns the receipt, without another mutation. Conflict/unknown outcome has
  no automatic retry or alternate write path.
  Full task-set comparison uses one JSON binding so the 100-task contract
  stays within [D1 parameter limits](https://developers.cloudflare.com/d1/platform/limits/).

Fixtures, failed reads, stale/invalid/future timestamps disable mutations.
Hydrated eligibility expires after 60 seconds; the dashboard clock re-evaluates
displayed state every five seconds. Worker checks remain the mutation authority.
All mutations require a confirmation showing scope, expected head where present,
and deploy impact. Buttons remain keyboard focusable when unavailable so their
reasons can be read. Touch targets are at least 48px in a two-column phone grid.

## Retry CI permission gate

Official GitHub documentation checked 2026-09-15:

- [Re-run failed jobs from a workflow run](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run)
  requires repository `Actions: write` for installation tokens and targets
  `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`.
- [Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
  documents the rerun window, original SHA/ref and original actor privileges.
  A rerun is not a workflow-dispatch request.

The approved dashboard installation session and
`src/integrations/github/app-read-rollout-plan.ts` request Actions read only.
The separate dormant `control-authorization.ts` workflow-dispatch registry is
not Retry CI authority. The current project capability contract does not enable
reruns. Source cannot prove the App's current production installation state.

Retry CI therefore remains visibly unavailable with the explicit reason:
“Retry CI unavailable: approved Control capability lacks Actions: write”.
`retry-ci.ts` validates exact repository/run/attempt/head binding and fresh failed
execution evidence, but never returns enabled. The client rejects forged Retry
CI eligibility and there is no rerun POST transport or generic dispatch route.

A separate gate must review and approve the dedicated Control App's narrowly
scoped Actions write permission, exact allowed repositories and safe CI workflows
(excluding production/manual workflows and unsafe dependent jobs), then implement
and validate a bounded live rerun executor with audit/replay protection. Merely
granting a permission will not activate this source's Retry CI control.

## Deployment inputs and boundaries

This change does not deploy, change App permissions, apply migrations or mutate
Cloudflare. Continue/Pause stay unavailable unless all of these are separately
configured and evidenced:

- existing `CONTROL_CONTINUATION_RUNTIME_ENABLED` equals exactly `true`;
- dedicated `CONTROL_CONTINUATION_ACCESS_ISSUER` and
  `CONTROL_CONTINUATION_ACCESS_AUDIENCE` match the approved owner Access policy;
- existing continuation schema/campaigns and source migration
  `0014_continuation_action_audit.sql` are applied through a separately authorized
  D1 gate, with the approved `CONTROL_DB` binding and GitHub read credentials;
- the exact reviewed Worker/UI version is deployed under separate authorization.

No configuration flag is changed by this source task. No migration applies
itself. Missing schema/auth/runtime fails closed. These are Control state writes,
never production application-data, host, Queue, credentials, infrastructure,
merge or deploy authority. RPi5 #532 is outside this task.
