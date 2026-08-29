# Phase 3 guarded Merge decision contract

Status: source-wired / `ops-workflows` capability prepared in source / production live Merge inactive.

Issues: #391, #393, #395, #436, #458. Prerequisite: #388 / PR #389. Decision contract: PR #392. React confirmed-action source wiring: PR #448.

## Purpose

This layer composes the exact-head GitHub Merge writer, authoritative decision coordinator, durable audit store and authenticated Worker handler/runtime boundary. Issue #436 wired the existing Merge route/runtime into the Worker source. PR #448 later source-wired the typed same-origin React Merge caller with a second explicit confirmation and exact decision evidence binding. Issue #458 deliberately prepares `canMerge=true` for exactly `rozkalnsandris/ops-workflows` in source while keeping the other five managed repositories disabled.

Source policy preparation is not live Merge authority. The #458 source change must still be explicitly merged, the production GitHub App must separately receive the minimum approved Merge permission, and a later production Worker rollout must be separately authorized before the prepared policy can exist in production runtime.

The decision service remains dependency-injected:

- authoritative GitHub read provider;
- branch-policy evidence reader;
- exact-head Merge writer;
- `MergeDecisionAuditStore`.

Issue #393 added the concrete D1 audit-store implementation plus source-controlled migration `0008_merge_decision_audit.sql`. Current canonical continuity records production D1 through migration `0009`; nevertheless, immediately before any future Merge live activation, fresh read-only evidence must still prove the expected `merge_decisions` schema/identity and a safe pre-state rather than relying on historical migration state.

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

## Authenticated Worker boundary

The exact route is `POST /api/github/merge`. The handler:

1. accepts only the exact route, `POST`, JSON media type, no query string and a bounded HTTP body;
2. authenticates through the existing cryptographic Cloudflare Access request authenticator;
3. rejects unknown request fields and actor injection;
4. validates request id, positive issue/PR numbers, exact lowercase 40-hex head/main SHA and one of the three explicit Merge methods;
5. resolves the managed project and requires `canMerge === true` before calling the decision executor;
6. returns only bounded Merge result/error evidence and never returns the authenticated actor, credentials or raw upstream payloads.

Issue #436 registers that existing handler in `src/worker/index.ts` and supplies the non-secret Merge Access issuer/audience bindings required by the existing runtime resolver. Missing or malformed issuer/audience configuration resolves to no runtime and fails closed.

`ManagedProjectPolicy` contains explicit `canMerge: boolean`. Under #458 source preparation, exactly one managed repository is enabled: `rozkalnsandris/ops-workflows`. The other five remain `canMerge=false`. Excluded and unknown repositories remain denied.

The runtime repeats the same trust-boundary check with `requireMergeProjectPolicy()` before it creates an authoritative repository decision context or invokes `executeMergeDecision`. Only after that inner gate could the authoritative read context, `D1MergeDecisionAuditStore`, one-repository `contents:write` installation session and exact-head Merge writer become reachable.

This double gate is intentional: Worker route reachability, configuration presence or caller mistakes must not grant Merge authority to any repository outside the exact project policy.

## Authoritative pre-write gate

After a successful audit claim, `executeMergeDecision` performs a fresh authoritative reconciliation for the exact repository/issue/PR. The writer remains unreachable unless the fresh result proves all of the following:

1. reconciliation is `PROJECTED` with complete branch-policy evidence;
2. projected expected/current head equals the owner-approved exact head SHA;
3. current default-branch/main SHA equals the owner-approved exact main SHA;
4. issue/PR identity is unchanged;
5. workflow state is `MERGE_READY`;
6. CI is `PASS`;
7. review requirements are satisfied.

Only then is the low-level writer called once with the exact approved head SHA and explicit merge method. The writer's own expected-head PUT guard remains the final GitHub concurrency check. There is no automatic refresh-and-retry on head conflict.

The lightweight `/api/github/dashboard` snapshot is intentionally observational: it never emits `MERGE_READY`, and its current PR projection does not supply the complete issue identity required by the Merge client. Therefore React caller reachability does not make a lightweight live card authoritative for Merge; authoritative reconciliation and project capability remain mandatory fail-closed gates.

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

Any future activated runtime must reconcile GitHub and durable audit state before any new authorization following an unknown or audit-finalization outcome.

## Source-prepared fail-closed boundary after #448 and #458

The merged source before #458 already provides:

- `/api/github/merge` registered in the Worker entrypoint;
- the existing Merge runtime resolver connected to the Worker environment;
- non-secret `CONTROL_MERGE_ACCESS_ISSUER` and `CONTROL_MERGE_ACCESS_AUDIENCE` configuration in source;
- the typed same-origin React `/api/github/merge` client;
- second-click confirmation with explicit `squash` and exact issue/PR/head/main binding;
- duplicate-submit suppression and canonical dashboard refresh after terminal results;
- fixture/loading/refreshing/error/stale dashboard suppression of mutating actions.

Issue #458 changes only the project-policy capability and its focused tests/documentation:

- `rozkalnsandris/ops-workflows`: `canMerge=true` in source;
- the other five managed repositories: `canMerge=false`;
- excluded/unknown repositories: fail closed;
- existing `canRequestChanges` and `canLater` values are unchanged.

The #458 source work does **not** perform or authorize:

- GitHub App `Contents: write` permission or repository-selection change;
- production Worker deployment;
- Cloudflare Access policy, secret or credential mutation;
- production D1 mutation or migration apply;
- creation of a new `ops-workflows` Merge-canary PR;
- any mutation or merge of `ops-workflows#3` (which remains MUST NEVER MERGE);
- backend live Merge canary;
- production/live GitHub Merge.

## Remaining activation gates

Before live Merge can exist, the independent gates are:

1. explicit owner merge authorization for the #458 source PR after exact-head CI/review is Ready; source merge is not deploy or GitHub App permission authorization;
2. fresh production D1 read-only verification of the `merge_decisions` schema/identity and clean canary pre-state; apply nothing unless fresh evidence proves a migration is genuinely missing and a separate DB authorization is granted;
3. explicit owner authorization for the minimum production GitHub App `Contents: write` permission while preserving the exact reviewed repository selection; permission growth is a separate trust-boundary mutation;
4. prepare a dedicated mergeable disposable canary target under its own reviewed gate; existing `ops-workflows#3` must never be used because it is explicitly forbidden to merge;
5. separately authorized production Worker rollout of an exact reviewed source SHA with a fresh production baseline; this is the step that can make the source-prepared `canMerge=true` policy reachable in production;
6. fresh read-only Merge preflight proving exact target issue/PR/head/main, required CI/checks, reviews, policy evidence, App permission and zero conflicting audit state;
7. one separately owner-authorized bounded backend Merge canary on that disposable target, with no retry after mutation starts;
8. production reliance on the already source-wired Merge UI only after backend canary evidence and a fresh production UI verification;
9. every later real Merge remains separately authorized and freshly revalidated.

Each gate is independent. Merge authorization is never deploy, DB, permission, Cloudflare or later live-action authorization.

## Deployment / migration classification

For the #458 source preparation:

- `Production deploy now: NO`;
- `Production deploy required later: YES` before the prepared `canMerge=true` policy can be active in production runtime;
- `Remote D1 migration/apply now: NO`; current continuity records production through `0009`, but fresh Merge-specific schema/pre-state verification remains required before live use;
- `GitHub App permission expansion now: NO`; future `Contents: write` remains separately owner-gated;
- `canMerge source preparation: YES` for `ops-workflows` only;
- `canMerge production activation: NO`;
- `Merge UI source wiring: YES`; production live use remains **NO**;
- `Live GitHub Merge: NO`.

The source preparation does not mutate production Cloudflare state, production D1, GitHub App permissions, repository selection or any managed repository.
