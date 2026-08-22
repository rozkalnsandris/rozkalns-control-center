# FAST-LANE v2.2 Composite — Rozkalns Control Center

This is the active local FAST-LANE v2.2 startup and operating contract. The older versioned filename remains only for backward compatibility. Issue #1 and all GitHub/Cloudflare/RPi5 trust boundaries remain authoritative.

## Primary operating rule

**The human approves the RISK / DECISION. Automation executes the TECHNICAL STEPS.**

STRICT describes mutation risk, not the number of human interactions. Read-only checkpoints MUST NOT create owner gates.

The Control Center target interaction is:

`one explicit human decision -> deterministic technical work continues -> next genuine human gate`

## FAST source envelope

`START`, `turpini`, or equivalent continuation may proceed from fresh canonical GitHub state through Ready for source/UI/tests/docs/deterministic orchestration work that does not expand permissions or execute a live mutation:

`fresh state -> issue/scope -> branch -> implementation -> focused tests -> commit/push -> Draft PR -> CI/review -> <=2 scope-preserving corrections -> Ready receipt -> STOP MERGE`

Batch 2-5 tightly related same-risk items inside one phase/subsystem when they form one acceptance story. Merge remains explicit and never authorizes live work.

## Human gate budget

Normal source-to-production delivery has at most two owner gates:

1. **MERGE** — exact Ready PR/head.
2. **COMPOSITE LIVE** — only when deploy/host/DB/permission/other live mutation is actually required.

Do not STOP for CI polling, GET preflight, GitHub evidence refresh, diff inspection, checkout discovery, clean/ancestor validation, build preparation, candidate GET verification or GET-only reconciliation.

Additional STOP is justified only when:

- merge authorization is required;
- one Composite Live authorization is required;
- an authorized mutation has started and an error/ambiguous result occurs;
- a new target/SHA/scope/trust-boundary/risk class appears.

## Composite Live authorization envelope

Before asking the owner, collect every obtainable read-only fact. The single authorization must bind:

- repository and exact approved Git SHA;
- exact production target/environment;
- expected production baseline/version when available;
- exact allowed mutation categories;
- hard operation counts/limits;
- explicit exclusions.

For the trusted Lenovo + Cloudflare Worker rollout pattern, one Composite Live authorization may explicitly allow both:

- trusted Lenovo checkout: `git fetch` and `git merge --ff-only` only, if required to reach the approved SHA;
- one bounded production rollout of the exact approved build/version.

That authorization does **not** include `reset`, `rebase`, `clean`, force operations, secrets, permission changes, D1/Queue mutation, DNS/Tunnel/Access changes, unrelated host mutation or any unlisted category.

If approved SHA/target/baseline changed, fail closed. Never adapt by deploying a newer `main`.

## One-shot Control rollout

After Composite Live authorization, use one fail-closed controller/script. The normal sequence is:

1. exact `main` + exact-main CI evidence;
2. production baseline GET/read;
3. trusted checkout clean + ancestor validation;
4. allowed `git fetch` + `git merge --ff-only` if required;
5. revalidate exact approved SHA and baseline immediately before first live write;
6. deterministic build using repository-pinned toolchain;
7. exactly one Cloudflare Worker version/artifact upload/create when required;
8. capture exact candidate/version ID;
9. automated candidate/version GET verification;
10. concurrency/drift guard — production baseline must still match expectation;
11. exactly one bounded deployment of the verified candidate/version;
12. GET-only production reconciliation;
13. one final receipt.

Build once and deploy the exact verified version. Do not rebuild between candidate verification and production rollout.

A standalone user-run read-only preflight script is not the normal FAST-LANE path. Its checks belong at the beginning of the one-shot and fail closed before the first mutation.

## Local STRICT boundaries

Composite Live authorization is required for production DB writes/migrations, GitHub App permission expansion, source-write capability activation, Cloudflare production mutation, RPi5/root/systemd/Docker/network changes, secrets/credentials, destructive cleanup and production rollout. Existing issue #1 / RPi5 contracts may impose stricter boundaries.

## Failure / rollback

Authorization is consumed at the first authorized mutation. After that, any error, ambiguity, unexpected drift or new scope requires evidence preservation and STOP.

Default behavior is no automatic retry, rollback, cleanup, reset, rebase or alternate mutation path. Rollback is itself a production mutation and requires explicit pre-authorization unless a narrower governing contract already proves and authorizes it.

## State model

Use these coarse states instead of inventing micro-states:

`SOURCE_FAST -> READY_MERGE -> WAITING_MERGE_AUTH -> POST_MERGE_READONLY -> WAITING_COMPOSITE_LIVE_AUTH -> LIVE_EXECUTING -> DONE`

Failure path after first mutation:

`LIVE_EXECUTING -> STOP_ERROR`

## Evidence and operator UX

Source work produces one Ready receipt. Live execution produces one final receipt containing approved/observed SHA, target, before/after production version/baseline, actual mutation counts, candidate verification, reconciliation, whether first mutation started/authorization was consumed, whether production changed and the exact next decision.

Do not make the owner shuttle intermediate output while automation can continue safely.

Any owner decision must be placed visibly at the **very end** of the response under one `ACTION REQUIRED` heading. First state what is done and what is not done. Then provide exactly the needed decision/command. When the owner must type or run something, put the exact copyable value in a fenced `bash` block.

## Merge invariant

Merge is always a separate owner decision and never authorizes deploy, DB, host, credential, permission or another live mutation.
