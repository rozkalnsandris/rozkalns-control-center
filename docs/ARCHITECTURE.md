# Architecture

This document describes the durable system boundaries for Rozkalns Control. Master issue #1 remains authoritative for current product scope and phase ordering.

## Goals

- mobile-first approval/status surface;
- one coherent view across managed GitHub projects;
- deterministic, auditable human actions;
- GitHub remains engineering source of truth;
- production remains behind existing RPi5 trust boundaries;
- no AI API requirement for the MVP.

## High-level architecture

```text
Android / desktop browser
        |
        v
Cloudflare Access
        |
        v
Rozkalns Control Worker + React SPA
        |
        +--> D1: projects, campaigns/tasks, approvals, projections
        +--> Queue/DLQ: GitHub event reconciliation
        +--> Workflows: durable waits/state machine where needed
        +--> Notifications: Telegram and/or web push
        |
        v
Dedicated Rozkalns Control GitHub App
        |
        v
GitHub repositories / issues / PRs / reviews / Actions

RPi5 production plane remains separate and authoritative.
```

## Frontend

Planned stack:

- React;
- TypeScript;
- Vite;
- Cloudflare Vite plugin;
- Workers Static Assets;
- Android-first responsive UI.

The frontend never receives GitHub App private keys or other privileged machine credentials.

## Worker API

The Worker is the trusted public control-plane API.

Responsibilities:

- validate Cloudflare Access identity for human routes;
- validate GitHub HMAC for webhook ingress;
- serve normalized read models;
- re-resolve live GitHub state before mutations;
- enforce capability/state transition rules;
- create immutable-ish approval/event evidence;
- enqueue reconciliation work;
- emit notifications.

## Authentication split

### Human routes

`control.rozkalns.net` is protected by Cloudflare Access. Worker authorization validates the signed JWT, expected issuer/JWKS/audience and authenticated identity.

### Machine webhook route

A separate route such as `hooks.control.rozkalns.net/github` accepts GitHub deliveries. It authenticates the raw request with GitHub webhook HMAC, not human Access identity.

## GitHub integration

Use a dedicated GitHub App named approximately `Rozkalns Control`.

Permission rollout:

1. read-only state ingestion;
2. exact writes required by human decision buttons;
3. future source-write permissions only if a later phase authorizes autonomous/source editing.

Do not broaden the existing RPi5 `Rozkalns Automation` verifier app.

GitHub remains canonical for:

- repository;
- branch/SHA;
- issue;
- pull request;
- review;
- Actions/check state.

The Control Center stores normalized references/projections and decisions, not a competing canonical Git history.

## Data plane

D1 stores bounded structured state such as:

- projects/integrations;
- campaigns/tasks;
- runs/events;
- approvals;
- GitHub entity projections;
- deploy-state projections;
- notification deliveries;
- webhook delivery deduplication.

Secrets are never stored in D1.

Large logs/evidence should use bounded retention and, when needed, object storage rather than unbounded D1 growth.

## Event ingestion

Webhook flow:

```text
raw GitHub request
  -> verify HMAC
  -> reject invalid
  -> dedupe delivery ID
  -> enqueue normalized event
  -> fast response
  -> queue consumer reconciles live GitHub state
  -> update projections/state
  -> notify only on meaningful transition
```

Retries are bounded and exhausted messages go to a Dead Letter Queue.

## Human decision flow

```text
NEEDS_ANDRIS card
  -> user chooses Merge / Needs changes / Later
  -> Worker validates Access identity
  -> Worker reloads live PR
  -> verify expected head SHA + CI + review/policy
  -> fail closed if stale/invalid
  -> execute exact GitHub action
  -> record decision/result
  -> reconcile resulting state
```

`Merge` does not imply deployment.

## Background continuation

The MVP may use ChatGPT + connected GitHub app and a pilot-proven Scheduled Task bridge. Control Center persists deterministic campaign state so continuation never relies on old chat memory.

Control Center must distinguish `READY` from actually executing work. It must never claim background execution merely because work is eligible.

## Production boundary

The production path remains:

`PR -> CI -> merge -> exact-SHA verification -> deploy-impact classification -> trusted RPi5 controller -> authorized helper -> health/evidence/rollback`

Rozkalns Control initially receives only sanitized/read-only production projections once that integration phase is explicitly approved.

## Future AI extension

Future optional architecture may add a provider-neutral agent runtime and isolated execution. That runtime must remain replaceable and must never receive production credentials. It is deliberately outside the MVP.
