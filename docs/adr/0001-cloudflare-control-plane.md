# ADR 0001 — Cloudflare-hosted control plane with GitHub as source of truth

- Status: Accepted
- Date: 2026-08-10
- Decision owners: Andris / Rozkalns Control master #1

## Context

Rozkalns Control needs a mobile-first approval/status surface that remains available independently of the RPi5 production host. It must integrate with GitHub without becoming a competing canonical code/PR/CI database, and it must preserve the existing RPi5 exact-SHA production trust boundary.

The MVP should avoid paid AI infrastructure and remain Free-tier-compatible where practical.

## Decision

Use a TypeScript-first Cloudflare application:

- React + TypeScript + Vite frontend;
- Cloudflare Vite plugin;
- Workers Static Assets;
- Cloudflare Worker API;
- Cloudflare Access for human authentication;
- D1 for bounded structured control/orchestration state;
- Queues + DLQ for GitHub webhook reconciliation;
- Workflows only where durable state/waits are useful.

Use a separate least-privilege GitHub App named approximately `Rozkalns Control`.

GitHub remains canonical for repositories, SHAs, issues, PRs, reviews and Actions/check status.

RPi5 remains canonical for production exact-SHA verification, deploy classification, privileged helpers, health and rollback.

AI provider/runtime integration is deferred to a final optional phase.

## Consequences

### Positive

- public control UI does not depend on RPi5 availability;
- mobile UI and API can ship as one Cloudflare application;
- GitHub integration can use a dedicated permission domain;
- event processing can be idempotent and retried without blocking webhook response;
- production control remains separated from public web control;
- MVP can focus on approvals before paying for AI/Sandbox infrastructure.

### Costs / constraints

- two authentication modes must be handled correctly: Access for humans, HMAC for GitHub webhooks;
- D1 projections must never be mistaken for canonical GitHub state;
- mutations require live GitHub revalidation;
- Cloudflare/GitHub product semantics must be rechecked against current official docs during implementation;
- future AI integration will require a new threat-model review and separate permission/cost decisions.

## Rejected alternatives

### Move projects to GitLab

Rejected for the current system. Existing GitHub public Actions, GitHub App trust model and current RPi5/GitHub automation investment make migration cost/risk larger than the expected benefit.

### Host Control Center directly on RPi5

Rejected as the public control-plane default because it couples availability and trust to the production host and encourages privilege shortcuts.

### Make AI/Sandbox the first implementation layer

Rejected. The immediate user value is safe mobile review/approval and notifications; AI API cost/complexity is intentionally deferred.

### Reuse the existing `Rozkalns Automation` GitHub App

Rejected. The verifier app and the future human-control app have different trust/permission growth paths and should remain separate.
