# Phase 2 GitHub read integration contract

Issue: #8  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration

## Purpose

Define the source-level trust boundary before any live GitHub App, credential, Cloudflare binding or production rollout exists.

This document is intentionally implementation-oriented, but it does **not** authorize creation/installation of a GitHub App or any live infrastructure change.

## Sequencing gate

The authoritative `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md` was re-read on 2026-08-10 before this task.

That program is still in Phase 3 — CV pull-deploy migration. Its current incomplete gates include the generic-maintenance Compose boundary / `cvbot` health prerequisite before the later controller rollout sequence.

Therefore this task may define and test source-only read contracts in parallel, but the later live GitHub App installation/permission rollout requires another explicit RPi5-plan reconciliation at that time.

Do not reuse or broaden the existing `Rozkalns Automation` RPi5 verifier App.

## Provider boundary

UI and orchestration code consume normalized read models through `SourceControlReadProvider`.

The Phase 2 provider contract contains reads only:

- repository/default-branch identity;
- default-branch head SHA;
- open issues;
- open PRs;
- one PR by number;
- PR reviews;
- check runs for the observed PR head SHA;
- workflow runs for the observed PR head SHA.

No create/update/review/rerun/merge/content-write method belongs in the Phase 2 interface.

`readAuthoritativePullRequestSnapshot()` binds check/workflow evidence to the same observed PR head SHA and rejects mismatched evidence. A future live adapter must populate this contract from GitHub; React components must not consume raw REST/GraphQL payloads directly.

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

## Planned GitHub REST read endpoints and minimum permissions

Official GitHub documentation was re-verified on 2026-08-10. This table is the initial endpoint plan; do not request permissions for endpoints that are not actually implemented.

| Read purpose | Planned REST endpoint | Minimum repository permission |
| --- | --- | --- |
| Repository metadata/default branch | `GET /repos/{owner}/{repo}` | Metadata: read |
| Main/default-branch commit | `GET /repos/{owner}/{repo}/commits/{ref}` | Contents: read |
| Repository issues | `GET /repos/{owner}/{repo}/issues` | Issues: read |
| Pull requests | `GET /repos/{owner}/{repo}/pulls` and `GET /repos/{owner}/{repo}/pulls/{pull_number}` | Pull requests: read |
| PR reviews | `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | Pull requests: read |
| Check runs for exact head | `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` | Checks: read |
| Workflow runs/jobs | workflow run/job read endpoints | Actions: read |

Do not add Commit statuses read unless real repositories prove it is required in addition to Checks/Actions.

Before registering the live App, re-check every implemented endpoint against GitHub's current "Permissions required for GitHub Apps" documentation and record the final minimal permission set in the phase-specific rollout issue.

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
  -> validate X-Hub-Signature-256 HMAC-SHA256
  -> reject invalid request
  -> only then interpret repository/event hints
  -> allow-list repository
  -> claim delivery ID
  -> enqueue/request reconciliation
  -> authoritative GitHub reread
```

Required source contract:

- `X-Hub-Signature-256` is mandatory and must match `sha256=<64 hex>`;
- `X-GitHub-Delivery` is mandatory;
- `X-GitHub-Event` is mandatory;
- signature verification uses Web Crypto HMAC verification rather than a normal string equality comparison;
- verification operates on the original payload bytes/string;
- webhook secret is injected at runtime and is never committed;
- the official GitHub `Hello, World!` HMAC test vector is covered by unit tests.

## Delivery deduplication

`DeliveryClaimStore` is the persistence boundary.

The in-memory implementation in this phase exists only for deterministic tests. It is **not** production persistence.

A future D1 implementation must make the delivery ID unique/atomic so concurrent/replayed deliveries cannot both win the claim.

Duplicate delivery is a safe no-op/error outcome, not a second reconciliation side effect.

## Webhook payload is not canonical truth

A webhook is a trigger/hint only.

Even after valid HMAC authentication:

- do not treat cached webhook PR/check/review fields as sufficient for a human decision;
- create a reconciliation trigger with `authoritativeReadRequired=true`;
- use the provider to re-read the repository/PR/head/check/review/workflow state;
- bind evidence to the exact observed PR head SHA;
- reject mismatched/stale evidence.

This rule will also apply before every future Phase 3 mutation.

## Production persistence / Queue / DLQ — deferred

This source-only task does not create:

- D1 database/binding;
- Queue;
- DLQ;
- Workflows;
- webhook route;
- GitHub App;
- secrets;
- Cloudflare deployment.

Those become separate, explicitly reviewed steps after the source contract and the active RPi5 plan are re-read.

## Validation requirements

Before #8 is merge-ready:

- official GitHub HMAC test vector PASS;
- missing/malformed signature/header cases PASS;
- duplicate delivery PASS/fail-closed as designed;
- excluded/unknown repositories rejected;
- exact-head evidence binding tested;
- source-boundary test proves no live `api.github.com`, Authorization header, `fetch()` transport or mutation methods in these Phase 2 source contracts;
- normal dependency audit, typecheck, lint, tests, Vite build and Wrangler dry-run PASS.

## Official references checked 2026-08-10

- GitHub Docs — Choosing permissions for a GitHub App
- GitHub Docs — Permissions required for GitHub Apps
- GitHub Docs — Generating an installation access token for a GitHub App
- GitHub Docs — Validating webhook deliveries
- GitHub Docs — REST API endpoints for pull requests and pull request reviews
- GitHub Docs — REST API endpoints for check runs
- GitHub Docs — REST API endpoints for workflow runs/jobs
- GitHub Docs — REST API endpoints for issues and commits

Re-check these docs before the live rollout because endpoint/permission semantics are external and may change.
