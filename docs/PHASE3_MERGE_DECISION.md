# Phase 3 dormant guarded Merge decision contract

Status: source-only / dormant.

Issues: #391, #393, #395. Prerequisite: #388 / PR #389. Decision contract: PR #392.

## Purpose

This layer composes the dormant exact-head GitHub Merge writer, authoritative decision coordinator, durable audit store and an authenticated Worker handler/runtime boundary without making Merge reachable from the deployed Worker or UI.

The decision service remains dependency-injected:

- authoritative GitHub read provider;
- branch-policy evidence reader;
- exact-head Merge writer;
- `MergeDecisionAuditStore`.

Issue #393 added the concrete **dormant D1 implementation** of that audit-store interface plus source-controlled migration `0008_merge_decision_audit.sql`. Issue #395 composes that existing store and the existing one-repository Merge writer/session behind a detached authenticated runtime. Migration `0008` is still not applied to remote D1 by this source unit.

## Request binding

Every request binds all decision-relevant identity:

- bounded request id;
- bounded actor subject/email derived only from verified Cloudflare Access identity;
- managed repository;
- exact issue and pull-request numbers;
- exact owner-approved PR head SHA;
- exact owner-approved main SHA;
- explicit `merge`, `squash` or `rebase` method.

The audit fingerprint includes all of those values. Reusing one request id with a different fingerprint is a conflict and fails before authoritative reread or mutation.

## Detached authenticated Worker boundary

Issue #395 adds source-only modules for exact `POST /api/github/merge` handling and Cloudflare runtime composition. They are deliberately **not imported by `src/worker/index.ts`**, have no Wrangler bindings, and have no UI caller.

The handler:

1. accepts only the exact route, `POST`, JSON media type, no query string and a bounded HTTP body;
2. authenticates through the existing cryptographic Cloudflare Access request authenticator;
3. rejects unknown request fields and actor injection;
4. validates request id, positive issue/PR numbers, exact lowercase 40-hex head/main SHA and one of the three explicit Merge methods;
5. resolves the managed project and requires `canMerge === true` before calling the decision executor;
6. returns only bounded Merge result/error evidence and never returns the authenticated actor, credentials or raw upstream payloads.

`ManagedProjectPolicy` now contains explicit `canMerge: boolean`. **All six currently managed repositories are `canMerge=false`.** Therefore every current managed repository is denied with `ACTION_NOT_ALLOWED` before the handler reaches decision execution.

The detached runtime repeats the same trust-boundary check with `requireMergeProjectPolicy()` before it creates an authoritative repository decision context or invokes `executeMergeDecision`. Only after that inner gate can the existing authoritative read context, `D1MergeDecisionAuditStore`, one-repository `contents:write` installation session and exact-head Merge writer become reachable.

This double gate is intentional: a future route wiring mistake or caller substitution must not make the runtime write-capable while project policy remains false.

## Authoritative pre-write gate

After a successful audit claim, `executeMergeDecision` performs a fresh authoritative reconciliation for the exact repository/issue/PR. The writer remains unreachable unless the fresh result proves all of the following:

1. reconciliation is `PROJECTED` with complete branch-policy evidence;
2. projected expected/current head equals the owner-approved exact head SHA;
3. current default-branch/main SHA equals the owner-approved exact main SHA;
4. issue/PR identity is unchanged;
5. workflow state is `MERGE_READY`;
6. CI is `PASS`;
7. review requirements are satisfied.

Only then is the low-level writer called once with the exact approved head SHA and explicit merge method. The writer's own expected-head PUT guard remains the final GitHub concurrency check.

## Durable D1 audit and replay model

`D1MergeDecisionAuditStore` implements the claim/terminal contract using the dedicated `merge_decisions` table.

The durable claim stores only bounded identity and audit evidence:

- request id and SHA-256 fingerprint;
- verified actor subject/email;
- managed repository/project identity;
- issue and PR numbers;
- explicit merge method;
- exact expected head/main SHA;
- timestamps.

It does **not** persist Access JWTs, GitHub tokens, private keys, secrets or arbitrary request payloads.

Claim states:

- `CLAIMED` — one atomic `INSERT ... ON CONFLICT DO NOTHING` owns the attempt;
- `REPLAY` — a matching validated terminal record already exists;
- `IN_PROGRESS` — fail closed; never race a second attempt;
- `CONFLICT` — same request id with a different fingerprint; fail closed.

Terminal outcomes are deliberately three-way:

- `SUCCEEDED` — exact Merge result including observed head/main and returned merge SHA; successful durable rows record `mutation_attempted=1`;
- `FAILED` — bounded terminal known failure plus exact `mutationAttempted` evidence (`0` before a write, `1` after a writer attempt);
- `UNKNOWN` — specifically `WRITE_OUTCOME_UNKNOWN`, always with `mutationAttempted=true`.

Completion updates only an exact `request_id + fingerprint + IN_PROGRESS` row. Successful completion additionally rebinds actor/repository/project/issue/PR/method/expected-SHA identity in the conditional update. Terminal rows cannot be overwritten.

A matching successful replay returns the stored result without rereading GitHub or issuing another Merge request. A replay of `FAILED` or `UNKNOWN` throws the stored failure with its original mutation-attempt evidence and never writes again. Malformed, ambiguous or identity-inconsistent durable rows fail closed.

## Writer failure mapping

- GitHub `HEAD_CONFLICT` -> `AUTHORIZATION_STALE_HEAD`, terminal known failure, mutation attempted, no retry;
- writer `WRITE_OUTCOME_UNKNOWN` or unexpected writer exception -> durable `UNKNOWN`, no retry;
- other bounded writer rejection -> `WRITE_REJECTED`, terminal known failure;
- malformed success evidence -> durable `UNKNOWN`;
- audit finalization failure after a writer attempt -> `AUDIT_FINALIZATION_FAILED`, mutation attempted, no retry.

A future activated runtime must reconcile GitHub and durable audit state before any new authorization following an unknown or audit-finalization outcome.

## Dormant boundary after #395

The source now contains the handler/runtime composition needed for a future activation, but #395 still does **not** introduce or activate:

- `canMerge=true` for any repository;
- `/api/github/merge` registration in the deployed Worker entrypoint;
- Merge Access variables or other Merge bindings in `wrangler.jsonc`;
- remote D1 migration application or production D1 writes;
- Merge UI/button/event wiring;
- GitHub App `Contents: write` permission/repository-selection change;
- Cloudflare configuration change;
- production deployment;
- live GitHub Merge.

The source migration and detached runtime are dormant artefacts only. Merging their source does not authorize any live action.

## Remaining activation gates

Before live Merge can exist, separate owner-gated steps still include:

1. fresh review of then-current GitHub/canonical state and exact-main CI;
2. separately owner-authorized remote D1 application of source-reviewed migration `0008`;
3. explicit owner authorization for the minimum GitHub App `Contents: write` permission and exact repository selection;
4. source-reviewed Worker entrypoint/Access binding activation with a deliberately selected project capability;
5. UI capability activation only after backend canary evidence;
6. separately authorized production rollout;
7. one separately authorized disposable live Merge canary with fresh exact-head/main/CI/review evidence.

Each gate is independent. Merge authorization is not deploy, migration, permission or capability-activation authorization.

## Deployment / migration classification

For #395:

- `Production deploy: NO`;
- `Remote D1 migration apply: NO / deferred`;
- `GitHub App permission expansion: NO`;
- `Live Merge capability: NO`.

The source slice changes policy defaults, detached Worker modules, tests and this documentation only. It does not change Worker entrypoints, `wrangler.jsonc`, UI behavior, remote D1, Cloudflare configuration or GitHub App settings.
