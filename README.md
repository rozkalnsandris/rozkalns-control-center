# Rozkalns Control

Mobile-first control and approval plane for Andris' engineering projects.

> **Status:** Phase 0 — repository contracts and bootstrap. No production deployment is authorized.

The canonical product contract is GitHub issue **#1 — `[MASTER / READ FIRST] Rozkalns Control — product contract, architecture and delivery roadmap`**. Read it before starting implementation work.

## What this product is for

The normal daily flow should become:

`work progresses → Needs Andris → phone notification → review evidence → Merge / Needs changes / Later → close phone → safe automation continues`

The first useful release is intentionally focused on approvals and visibility rather than AI-provider integration.

### MVP

- Android-first `Needs Andris` queue;
- project, issue, PR, CI and review visibility;
- safe deterministic `Merge`, `Needs changes` and `Later` actions;
- stale-head/SHA and CI revalidation before mutations;
- quiet notifications with deep links to the exact decision;
- existing GitHub/RPi5 automation remains authoritative after merge;
- no OpenAI/Claude API requirement.

### Not MVP

- autonomous AI coding workers;
- Cloudflare Sandbox SDK;
- AI Gateway/provider routing;
- direct RPi5 SSH/sudo or production mutation;
- production DB writes from the control plane.

## Initial managed projects

- `rozkalnsandris/hermes-tech`
- `rozkalnsandris/hermes-deals`
- `rozkalnsandris/rozkalns-cv`
- `rozkalnsandris/RPi5_main`
- `rozkalnsandris/ops-workflows`
- `rozkalnsandris/rozkalnsandris`

`rozkalnsandris/hermes-email-skill` is explicitly excluded from the initial scope.

## Trust boundaries

- **GitHub** — source of truth for repository, SHA, issues, PRs, reviews and CI.
- **Rozkalns Control** — approval/orchestration projection, notification state and audit evidence.
- **ChatGPT** — current reasoning/operator layer through the connected GitHub app where supported; not a canonical state store.
- **RPi5** — production trust boundary, exact-SHA deploy rules, health and rollback authority.

**Merge authorization is not deploy authorization.**

## Planned platform

- React + TypeScript + Vite;
- Cloudflare Vite plugin + Workers Static Assets;
- Cloudflare Worker API;
- Cloudflare Access for human authentication;
- D1 for structured control state;
- Queues + DLQ for webhook reconciliation;
- Workflows only where durable waits/state machines add value.

The initial design targets Cloudflare Free-compatible components where practical. Paid AI/Sandbox infrastructure is deferred.

## Repository map

- [`AGENTS.md`](AGENTS.md) — mandatory worker/assistant rules;
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution and PR workflow;
- [`SECURITY.md`](SECURITY.md) — security policy;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system boundaries and component architecture;
- [`docs/STATE_MODEL.md`](docs/STATE_MODEL.md) — deterministic task/approval state contract;
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — threats and required mitigations;
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phase gates and exit criteria;
- [`docs/adr/`](docs/adr/) — durable architecture decisions.

## Development rule

Before every task:

1. re-read master issue #1;
2. identify the current phase and first incomplete exit criterion;
3. inspect repository instructions and current diff/state;
4. work only that scope and necessary prerequisites;
5. validate narrowly first, then broader as required;
6. use a task branch and Draft PR;
7. never interpret merge as production authorization.

No secrets belong in this public repository.
