# Phase 3 dormant guarded Merge decision contract

Status: source-only / dormant.

Issue: #391. Prerequisite: #388 / PR #389.

## Purpose

This layer sits above the dormant exact-head GitHub Merge writer and below any future Worker route or UI action. It prepares the authoritative pre-write and audit/idempotency semantics required for a safe human-approved Merge without activating Merge in production.

The decision service is intentionally dependency-injected:

- authoritative GitHub read provider;
- branch-policy evidence reader;
- exact-head Merge writer;
- abstract audit/idempotency store.

There is no concrete D1 Merge adapter, migration, Worker route, UI action or production binding in this unit.

## Request binding

Every request binds all decision-relevant identity:

- bounded request id;
- bounded actor subject/email;
- managed repository;
- exact issue and pull-request numbers;
- exact owner-approved PR head SHA;
- exact owner-approved main SHA;
- explicit `merge`, `squash` or `rebase` method.

The audit fingerprint includes all of those values. Reusing one request id with a different fingerprint is a conflict and fails before authoritative reread or mutation.

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

## Audit and replay model

The injected `MergeDecisionAuditStore` separates claim from terminal completion.

Claim states:

- `CLAIMED` — this request owns the one attempt;
- `REPLAY` — a matching terminal record already exists;
- `IN_PROGRESS` — fail closed; never race a second attempt;
- `CONFLICT` — same request id with different fingerprint; fail closed.

Terminal outcomes are deliberately three-way:

- `SUCCEEDED` — contains the complete Merge result, including returned merge SHA;
- `FAILED` — a terminal known failure plus whether a write was attempted;
- `UNKNOWN` — specifically `WRITE_OUTCOME_UNKNOWN`, always with `mutationAttempted=true`.

A matching successful replay returns the stored result without rereading GitHub or issuing another Merge request. A replay of `FAILED` or `UNKNOWN` throws the stored failure with its original mutation-attempt evidence and never writes again.

This distinction is required because an ambiguous network/response outcome after a Merge request must never be converted into a blind retry.

## Writer failure mapping

- GitHub `HEAD_CONFLICT` -> `AUTHORIZATION_STALE_HEAD`, terminal known failure, mutation attempted, no retry;
- writer `WRITE_OUTCOME_UNKNOWN` or unexpected writer exception -> durable `UNKNOWN`, no retry;
- other bounded writer rejection -> `WRITE_REJECTED`, terminal known failure;
- malformed success evidence -> durable `UNKNOWN`;
- audit finalization failure after a writer attempt -> `AUDIT_FINALIZATION_FAILED`, mutation attempted, no retry.

A future runtime must reconcile GitHub and durable audit state before any new authorization following an unknown or audit-finalization outcome.

## Dormant boundary

Issue #391 does **not** introduce:

- `canMerge` in project policy;
- `/api/github/merge` or any Worker runtime composition;
- D1 Merge schema/store/migration;
- Merge UI/button/event wiring;
- GitHub App permission/repository-selection change;
- Cloudflare configuration/binding change;
- production deployment;
- live GitHub Merge.

The service is unreachable from deployed runtime until a separately reviewed source unit wires it after the required trust gates.

## Remaining future gates

Before live Merge can exist, separate gates still include:

1. concrete durable audit/idempotency persistence design and migration, if D1 is selected;
2. explicit owner authorization for the minimum GitHub App `Contents: write` permission and exact repository selection;
3. authenticated Worker route/runtime wiring with project capability gating;
4. UI capability activation only after backend canary evidence;
5. separately authorized production rollout;
6. one separately authorized disposable live Merge canary with fresh exact-head/main/CI/review evidence.

## Deployment classification

`Production deploy: NO`.

This unit adds only a dormant shared decision contract, tests and documentation. It does not change Worker entrypoints, runtime composition, project capabilities, `wrangler.jsonc`, D1 schema or UI behavior.
