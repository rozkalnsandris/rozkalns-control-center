# State Model

This document defines deterministic Control Center state. It exists so continuation and approvals do not depend on old chat context.

## Principles

- GitHub is canonical for repository/PR/CI truth.
- Control Center state is a projection/orchestration record, not a substitute Git database.
- State transitions are validated server-side.
- Human approval is an explicit authenticated event.
- Stale approval state fails closed.
- `READY` means eligible, not currently executing.

## Core entities

### Project

Represents one managed repository and its capabilities/policies.

### Campaign

A durable user intent spanning multiple work units, for example:

```text
project: Hermes Deals
scope: Lidl
mode: continue issues
continue_enabled: true
```

### Task / work unit

One concrete issue/change unit inside a campaign.

### Run

One attempt/execution cycle for a task. MVP runs may represent external/manual/ChatGPT-driven work rather than an internal AI worker.

### Approval

A human decision bound to an exact target and expected state/SHA.

### Projection

Cached normalized GitHub or production state used for display. Never sufficient alone for a write decision.

## MVP state vocabulary

Normal states:

- `DISCOVERED` — known but not yet eligible/selected;
- `READY` — eligible for the next safe work step;
- `WORKING` — evidence shows actual work is in progress;
- `WAITING` — waiting on external deterministic condition;
- `PR_DRAFT` — draft PR exists;
- `WAIT_CI` — waiting for required CI/checks;
- `REVIEW` — waiting for review/evaluation;
- `NEEDS_ANDRIS` — a real human decision is required;
- `MERGE_READY` — current evidence satisfies merge-readiness policy, still requiring approved action;
- `MERGED` — GitHub confirms merge;
- `DEPLOY_DECISION` — post-merge deployment class/decision pending or being resolved;
- `PRODUCTION_VERIFY` — production verification is pending/observed;
- `DONE` — task/campaign unit complete.

Hold/failure states:

- `PAUSED`;
- `BLOCKED`;
- `CI_FAILED`;
- `CANCELLED`.

Do not add AI-only states until AI execution exists.

## Example campaign record

```text
Project: Hermes Deals
Scope: Lidl
Mode: continue issues
Current issue: #123
Current PR: #126
Expected PR head: abcdef...
State: NEEDS_ANDRIS
Next eligible issue: #124
Continue enabled: true
Human gate: MERGE
```

## Merge approval contract

An approval record should include at minimum:

- approval ID;
- actor identity;
- repository/PR target;
- requested action;
- expected PR head SHA;
- observed CI/review policy snapshot;
- created timestamp;
- consumed timestamp/result;
- resulting merge SHA when successful.

Before executing `Merge`, re-read GitHub and compare live state with the approval's expected state. If the head or required policy changed, do not reuse the approval.

## `Later`

`Later` changes notification/decision scheduling only. It is neither approval nor rejection. It must not advance the task through a protected action.

## `Needs changes`

Represents explicit human rejection/request-for-change. It may map to a GitHub review/comment operation only when that exact operation is implemented and permitted.

## `Continue`

Campaign-level permission to proceed through already-declared safe transitions. It never implies permission to merge, deploy, write a production database or mutate the host.

## `Pause`

Suspends Control Center continuation/notifications for the defined scope. It does not retroactively cancel unrelated already-running GitHub/production jobs.

## Post-merge transition

After a confirmed merge:

1. record actual merge result/SHA;
2. mark the current task `MERGED`;
3. resolve deployment classification from authoritative evidence;
4. allow existing repository/RPi5 automation to proceed under its own policy;
5. mark the next eligible task `READY` only after re-reading canonical GitHub state;
6. background continuation may pick it up later;
7. notify only at the next meaningful human gate/blocker.

## Idempotency

Every side-effecting Control Center action must have an idempotency strategy. Replayed web requests, webhook deliveries or workflow retries must not accidentally execute the same protected action twice.
