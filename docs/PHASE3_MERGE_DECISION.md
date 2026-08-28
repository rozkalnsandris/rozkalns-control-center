# Phase 3 guarded Merge decision contract

Status: source-wired / capability disabled.

Issues: #391, #393, #395, #436. Prerequisite: #388 / PR #389. Decision contract: PR #392. React confirmed-action source wiring: PR #448.

## Purpose

This layer composes the exact-head GitHub Merge writer, authoritative decision coordinator, durable audit store and authenticated Worker handler/runtime boundary. Issue #436 wired the existing Merge route/runtime into the Worker source while deliberately keeping every managed repository `canMerge=false` and, at that time, keeping the UI demo-only. PR #448 later source-wired the typed same-origin React Merge caller with a second explicit confirmation and exact decision evidence binding; every managed repository still remains `canMerge=false`, so source caller reachability is not live Merge authority.

Route reachability is not Merge authority. A future deployment of this source can expose the authenticated route, but the current project-policy gate denies every managed repository before decision execution, D1 audit work, GitHub credential creation or a Merge writer call.

The decision service remains dependency-injected:

- authoritative GitHub read provider;
- branch-policy evidence reader;
- exact-head Merge writer;
- `MergeDecisionAuditStore`.

Issue #393 added the concrete D1 audit-store implementation plus source-controlled migration `0008_merge_decision_audit.sql`. Issue #395 composed that store and the one-repository Merge writer/session behind an authenticated runtime. Migration `0008` remains unapplied to remote production D1 under #436.

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

`ManagedProjectPolicy` contains explicit `canMerge: boolean`. **All six currently managed repositories remain `canMerge=false`.** Therefore every current managed repository is denied with `ACTION_NOT_ALLOWED` before the handler calls `executeDecision`.

The runtime repeats the same trust-boundary check with `requireMergeProjectPolicy()` before it creates an authoritative repository decision context or invokes `executeMergeDecision`. Only after that inner gate could the authoritative read context, `D1MergeDecisionAuditStore`, one-repository `contents:write` installation session and exact-head Merge writer become reachable.

This double gate is intentional: Worker route reachability, configuration presence or a future caller mistake must not make the runtime write-capable while project policy remains false.

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

The lightweight `/api/github/dashboard` snapshot is intentionally observational: it never emits `MERGE_READY`, and its current PR projection does not supply the complete issue identity required by the Merge client. Therefore the #448 React source wiring does not make a lightweight live card Merge-capable; authoritative reconciliation and project capability remain mandatory fail-closed gates.

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

## Source-wired fail-closed boundary after #436 and #448

Issue #436 changed Worker route/runtime reachability:

- `/api/github/merge` is registered in the Worker entrypoint;
- the existing Merge runtime resolver is connected to the Worker environment;
- non-secret `CONTROL_MERGE_ACCESS_ISSUER` and `CONTROL_MERGE_ACCESS_AUDIENCE` configuration is present in source;
- source tests prove route reachability, runtime fail-closed configuration behavior and six `canMerge=false` policies.

PR #448 later changed caller source only:

- React uses the typed same-origin `/api/github/merge` client;
- the first Merge click only opens an explicit confirmation;
- confirmation explicitly selects `squash` and binds exact issue/PR/head/main evidence with a fresh bounded request id;
- duplicate submission is blocked while an action is in flight;
- terminal success or failure triggers a canonical dashboard refresh;
- fixture/loading/refreshing/error/stale dashboard states suppress mutating actions.

The combined source still does **not** introduce or activate:

- `canMerge=true` for any repository;
- remote D1 migration application or production D1 writes;
- GitHub App `Contents: write` permission or repository-selection change;
- Cloudflare Access policy, secret or credential mutation;
- production Worker deployment;
- backend live Merge canary;
- production/live GitHub Merge.

Source UI wiring is not production UI activation and does not grant later mutation authority.

## Remaining activation gates

Before live Merge can exist, separate owner-gated steps still include:

1. fresh review of then-current GitHub/canonical state and exact-main CI;
2. separately owner-authorized remote D1 application of source-reviewed migration `0008` if fresh production evidence shows it is still pending;
3. explicit owner authorization for the minimum GitHub App `Contents: write` permission and exact repository selection;
4. a separately reviewed deliberate project-policy activation changing only an intended repository to `canMerge=true`;
5. separately authorized production Worker rollout with a fresh production baseline;
6. one bounded backend canary on a disposable target with fresh exact-head/main/CI/review evidence;
7. production reliance on the already source-wired Merge UI only after backend canary evidence and a fresh production UI verification;
8. any later real Merge remains separately authorized and freshly revalidated.

Each gate is independent. Source merge authorization is not deploy, migration, permission, capability activation or live Merge authorization.

## Deployment / migration classification

For the current source after #448:

- `Production deploy: NO / not performed by source merge`; a separate later Worker rollout is required for current source to exist in production;
- `Remote D1 migration apply: historical #436 state was deferred; fresh production evidence is required before any future Merge activation`;
- `GitHub App permission expansion: NO`;
- `canMerge capability activation: NO`;
- `Merge UI source wiring: YES`; production UI activation/use remains **NO**;
- `Live GitHub Merge: NO`.

The merged source does not mutate production Cloudflare state, production D1, GitHub App permissions, repository selection or any managed repository.