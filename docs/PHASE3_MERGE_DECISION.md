# Phase 3 dormant guarded Merge decision contract

Status: source-only / dormant.

Issues: #391, #393. Prerequisite: #388 / PR #389. Decision contract: PR #392.

## Purpose

This layer sits above the dormant exact-head GitHub Merge writer and below any future Worker route or UI action. It prepares the authoritative pre-write, durable audit and idempotency semantics required for a safe human-approved Merge without activating Merge in production.

The decision service remains dependency-injected:

- authoritative GitHub read provider;
- branch-policy evidence reader;
- exact-head Merge writer;
- `MergeDecisionAuditStore`.

Issue #393 adds a concrete **dormant D1 implementation** of that audit-store interface plus source-controlled migration `0008_merge_decision_audit.sql`. The adapter is not composed into Worker runtime, and the migration is not applied to remote D1 by this source unit.

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

A future runtime must reconcile GitHub and durable audit state before any new authorization following an unknown or audit-finalization outcome.

## Dormant boundary

Issues #391/#393 still do **not** introduce or activate:

- `canMerge` in project policy;
- `/api/github/merge` or any Worker runtime composition;
- remote D1 migration application or production D1 writes;
- Merge UI/button/event wiring;
- GitHub App permission/repository-selection change;
- Cloudflare configuration/binding change;
- production deployment;
- live GitHub Merge.

The migration is a source artefact only. Applying `0008` to remote D1 is a separate owner-gated live action and is not authorized by merging its source PR.

## Remaining future gates

Before live Merge can exist, separate gates still include:

1. separately owner-authorized remote D1 application of source-reviewed migration `0008`;
2. explicit owner authorization for the minimum GitHub App `Contents: write` permission and exact repository selection;
3. authenticated Worker route/runtime wiring with project capability gating;
4. UI capability activation only after backend canary evidence;
5. separately authorized production rollout;
6. one separately authorized disposable live Merge canary with fresh exact-head/main/CI/review evidence.

## Deployment / migration classification

- `Production deploy: NO` for the #393 source slice.
- `Remote D1 migration apply: REQUIRED LATER, NOT AUTHORIZED BY MERGE`.

The source slice adds only dormant D1 persistence, migration source, tests and this documentation. It does not change Worker entrypoints, runtime composition, project capabilities, `wrangler.jsonc` or UI behavior.
