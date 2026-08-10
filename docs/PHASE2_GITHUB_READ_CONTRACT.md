# Phase 2 GitHub read integration contract

Issues: #8, #19  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration

## Purpose

Define the source-level trust boundary before any live GitHub App, credential, Cloudflare binding or production rollout exists.

This document is intentionally implementation-oriented, but it does **not** authorize creation/installation of a GitHub App or any live infrastructure change.

## Sequencing gate

The authoritative `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md` was re-read on 2026-08-10 during issue #19.

That program remains in Phase 3 — CV pull-deploy migration. CV recovery is complete; its first incomplete gate is now the cross-repository #140 evidence-directory contract between the RPi5 controller producer and the CV root pull-wrapper allow-list.

Therefore source-only read/evidence contracts may proceed in parallel, but the later live GitHub App installation/permission rollout requires another explicit RPi5-plan reconciliation at that time.

Do not reuse or broaden the existing `Rozkalns Automation` RPi5 verifier App.

## Provider boundary

UI and orchestration code consume normalized read models through `SourceControlReadProvider`.

The Phase 2 provider contract contains reads only:

- repository/default-branch identity;
- default-branch head SHA;
- open issues;
- open PRs;
- one PR by number;
- exact-head PR merge state;
- PR reviews;
- Check Runs for the observed PR head SHA;
- commit statuses for the observed PR head SHA;
- workflow runs for the observed PR head SHA.

No create/update/review/rerun/merge/content-write method belongs in the Phase 2 interface.

`readAuthoritativePullRequestSnapshot()` binds merge-state, Check Run, commit-status and workflow evidence to the same observed PR head SHA and rejects mismatched evidence. A future live adapter must populate this contract from GitHub; React components must not consume raw REST/GraphQL payloads directly.

## Managed repository policy

The allow-list is configuration driven in `src/shared/project-policy.ts`.

Initial enabled read scope:

- `rozkalnsandris/hermes-tech`
- `rozkalnsandris/hermes-deals`
- `rozkalnsandris/rozkalns-cv`
- `rozkalnsandris/RPi5_main`
- `rozkalnsandris/ops-workflows`
- `rozkalnsandris/rozkalnsandris`

Explicitly excluded:

- `rozkalnsandris/hermes-email-skill`

Unknown, disabled or excluded repositories fail closed.

## Planned GitHub reads and minimum permissions

Official GitHub documentation was re-verified on 2026-08-10. This table is a source-only endpoint plan; do not request a permission until the corresponding live endpoint is actually implemented and canaried.

| Read purpose | Planned GitHub read | Minimum repository permission |
| --- | --- | --- |
| Repository metadata/default branch | `GET /repos/{owner}/{repo}` | Metadata: read |
| Main/default-branch commit | `GET /repos/{owner}/{repo}/commits/{ref}` | Contents: read |
| Repository issues | `GET /repos/{owner}/{repo}/issues` | Issues: read |
| Pull requests | `GET /repos/{owner}/{repo}/pulls` and `GET /repos/{owner}/{repo}/pulls/{pull_number}` | Pull requests: read |
| PR reviews | `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | Pull requests: read |
| Check Runs for exact head | `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` | Checks: read |
| Commit statuses for exact head | `GET /repos/{owner}/{repo}/commits/{ref}/statuses` | Commit statuses: read |
| Workflow runs/jobs | workflow run/job read endpoints | Actions: read |
| Active rules for branch | `GET /repos/{owner}/{repo}/rules/branches/{branch}` | Metadata: read |
| Classic branch protection, only if separately approved after canary evidence | `GET /repos/{owner}/{repo}/branches/{branch}/protection` | Administration: read |

Issue #19 adds only the **source model** for commit-status evidence. It does not add `Commit statuses: read` to any live App because no dedicated Control App or live adapter exists yet.

Before registering the live App, re-check every implemented endpoint against GitHub's current permission documentation and record the final minimal permission set in the phase-specific rollout issue.

## Required status evidence

A GitHub required status context can be satisfied by Check Run evidence or legacy commit-status evidence depending on the repository configuration.

Source rules:

- all evidence is bound to the exact observed PR head SHA;
- commit-status context matching is case-insensitive;
- `GET .../statuses` is modeled newest-first and only the latest effective status per case-insensitive context is retained;
- commit-status states are `success`, `failure`, `error`, `pending`;
- completed Check Run conclusions `success`, `neutral` and `skipped` satisfy GitHub required-status semantics;
- explicit failure conclusions remain failures; non-final/ambiguous conclusions remain running/waiting rather than being invented as success;
- Check Run `app.id` is preserved so App-bound required checks can prove producer identity;
- if a required context is bound to a specific GitHub App, same-named evidence from another or unknown Check producer cannot satisfy it;
- a commit status cannot prove a Check App identity, so it cannot independently satisfy an App-bound requirement;
- when same-context Check and commit-status evidence coexist, Control evaluates the relevant evidence conservatively instead of dropping a failing source.

## Installation-token rules

When the future live adapter is implemented:

- authenticate as a dedicated `Rozkalns Control` GitHub App installation;
- use short-lived installation access tokens;
- installation tokens expire after one hour under the current GitHub contract;
- narrow tokens to exact repositories/permissions where useful;
- never use a classic PAT as machine identity;
- never log JWTs, installation tokens or private keys;
- do not depend on token string length or legacy token format;
- private key belongs only in an appropriate secret binding/store.

As of 2026, GitHub has rolled out a stateless installation-token format, so token-length validation is explicitly forbidden.

## Webhook authentication

The future ingress order is fixed:

```text
raw request bytes
  -> read required GitHub headers
  -> validate X-Hub-Signature-256 HMAC-SHA256 over the original payload
  -> reject invalid request
  -> only after successful verification parse the same payload
  -> derive repository identity from payload.repository.full_name
  -> allow-list repository
  -> claim delivery ID
  -> enqueue/request reconciliation
  -> authoritative GitHub reread
```

Required source contract:

- `X-Hub-Signature-256` is mandatory and must match `sha256=<64 hex>`;
- `X-GitHub-Delivery` is mandatory;
- `X-GitHub-Event` is mandatory;
- signature verification uses Web Crypto HMAC verification rather than normal string equality;
- verification operates on the original payload bytes/string;
- repository identity used for reconciliation is derived from that authenticated payload, not accepted as an independent caller hint;
- webhook secret is injected at runtime and is never committed;
- the official GitHub `Hello, World!` HMAC test vector remains covered by unit tests.

## Delivery deduplication

`DeliveryClaimStore` is the persistence boundary.

The in-memory implementation in this phase exists only for deterministic tests. It is **not** production persistence.

A future D1 implementation must make the delivery ID unique/atomic so concurrent/replayed deliveries cannot both win the claim.

Duplicate delivery is a safe no-op/error outcome, not a second reconciliation side effect.

## Webhook payload is not canonical truth

A webhook is a trigger only.

Even after valid HMAC authentication:

- do not treat cached webhook PR/check/review/status fields as sufficient for a human decision;
- create a reconciliation trigger with `authoritativeReadRequired=true`;
- use the provider to re-read repository/PR/head/merge/check/status/review/workflow state;
- bind evidence to the exact observed PR head SHA;
- reject mismatched/stale evidence.

This rule will also apply before every future Phase 3 mutation.

## Production persistence / Queue / DLQ — deferred

This source-only work does not create:

- D1 database/binding;
- Queue;
- DLQ;
- Workflows;
- webhook route;
- GitHub App;
- secrets;
- Cloudflare deployment.

Those become separate, explicitly reviewed steps after source contracts are green and the active RPi5 plan is re-read.

## Validation requirements

Before issue #19 is merge-ready:

- official GitHub HMAC test vector PASS;
- verified payload repository binding PASS;
- missing/malformed signature/header/payload cases fail closed;
- duplicate delivery PASS/fail-closed as designed;
- excluded/unknown repositories rejected;
- exact-head Check/status/workflow/merge evidence binding tested;
- latest case-insensitive commit-status selection tested;
- Check Run producer identity and mismatch behavior tested;
- `neutral`/`skipped` required-Check behavior tested;
- source-boundary test proves no live `api.github.com`, Authorization header, `fetch()` transport or mutation methods in these Phase 2 source contracts;
- normal dependency audit, typecheck, lint, tests, Vite build and Wrangler dry-run PASS.

## Official references checked 2026-08-10

- GitHub Docs — Choosing permissions for a GitHub App
- GitHub Docs — Permissions required for GitHub Apps
- GitHub Docs — Generating an installation access token for a GitHub App
- GitHub Docs — Validating webhook deliveries
- GitHub Docs — Webhook events and payloads
- GitHub Docs — REST API endpoints for pull requests and pull request reviews
- GitHub Docs — REST API endpoints for Check Runs
- GitHub Docs — REST API endpoints for commit statuses
- GitHub Docs — REST API endpoints for workflow runs/jobs
- GitHub Docs — REST API endpoints for repository rules and branch protection
- GitHub Docs — REST API endpoints for issues and commits

Re-check these docs before the live rollout because endpoint/permission semantics are external and may change.
