# Contributing to Rozkalns Control

This repository is intentionally governed by a strict phase-based workflow because it will eventually perform security-sensitive GitHub approval actions.

## Before starting

1. Read master issue #1.
2. Read `AGENTS.md`.
3. Confirm the current delivery phase and the first incomplete exit criterion.
4. Confirm the task is inside that phase or is a required prerequisite.
5. Check current official vendor documentation when the task depends on GitHub, Cloudflare or ChatGPT product behavior.

## Branch and PR workflow

Use a task-specific branch from current `main`.

Recommended names:

- `bootstrap/...`
- `docs/...`
- `feat/...`
- `fix/...`
- `security/...`
- `test/...`

Do not commit feature work directly to `main`.

A normal change should follow:

`task → branch → focused validation → broader required validation → commit → Draft PR → CI/review → explicit merge`

## Scope rules

- One task, one coherent concern.
- Do not bundle unrelated cleanup.
- Do not expand GitHub App permissions unless the current task requires and authorizes it.
- Do not introduce production/RPi5 mutations from this repository without a separately authorized integration phase.
- Do not introduce AI API/Sandbox runtime before the final optional AI phase.

## Pull request requirements

Every PR must describe:

- why the change exists;
- exact scope;
- changed behavior/contracts;
- validation performed;
- security impact;
- deploy impact;
- what is deliberately not changed.

For approval/mutation code, include tests for stale state and fail-closed behavior.

For webhook/event code, include signature/idempotency/retry behavior in scope.

## Commit discipline

- Keep commits understandable and scoped.
- Never stage unrelated paths.
- Never commit secrets or local environment material.
- No force-push/history rewrite without explicit authorization.

## Documentation

Long-lived decisions belong in the appropriate durable location:

- master issue #1 — current normative product/roadmap contract;
- `docs/ARCHITECTURE.md` — system/component architecture;
- `docs/STATE_MODEL.md` — task/approval state semantics;
- `docs/THREAT_MODEL.md` — threats/mitigations;
- `docs/adr/` — architecture decisions with context and consequences;
- `SECURITY.md` — vulnerability/security reporting policy.

When a master decision changes, update the governing normative section rather than accumulating contradictory notes.

## Deployment

A merge to this repository is not authorization to deploy Cloudflare infrastructure or mutate RPi5 production. Deployment is introduced only by the phase-specific contracts that explicitly define and gate it.
