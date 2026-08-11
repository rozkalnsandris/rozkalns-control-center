# Phase 2 GitHub projection and parity contract

Issues: #10, #19, #28  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration, source-only continuation

## Purpose

Define how documented GitHub response fields become Rozkalns Control read models without introducing live transport, credentials, mutations or production bindings.

This layer is deliberately pure. A later live adapter may obtain JSON from GitHub, but it must pass that data through the same validation, latest-effective evidence selection and projection rules before the UI can consume it.

## Fail-closed payload mapping

The REST mapper consumes only fields that Rozkalns Control currently needs:

- repository: `full_name`, `default_branch`;
- pull request: number/title/state/draft, base ref+SHA, head ref+SHA, changed-file count and HTML URL;
- review: id/state/actor/submission timestamp;
- check run: id/name/status/conclusion/head SHA/producer App/order timestamps/details URL;
- commit status: id/context/state/head SHA/creation timestamp/target URL;
- workflow run: id/workflow identity/run number/run attempt/name/status/conclusion/head SHA/order timestamps/HTML URL;
- issue: number/title/state/HTML URL.

Missing critical fields or unsupported enum values throw instead of silently defaulting. Ordering-only fields may be absent in source-only fixtures/providers; when absent, the evidence remains unorderable and conservative rather than being guessed as newest.

Current check-run status handling includes GitHub's pending-like states (`waiting`, `requested`, `pending`) in addition to `queued`, `in_progress` and `completed`. Pending-like states never imply success.

## Exact-head evidence

Check/status/workflow evidence is useful only when its head SHA equals the currently observed pull-request head SHA.

The source layer therefore has two protections:

1. mapper helpers discard evidence from another head SHA before latest-effective selection;
2. authoritative snapshot projection reasserts exact-head equality and throws if mixed evidence reaches it.

Branch name alone is never sufficient evidence.

## Latest-effective CI evidence

GitHub can retain multiple Check Runs, commit statuses and workflow runs for the same pull-request head. Retries/reruns must not allow stale evidence to control the current projection forever.

Rozkalns Control therefore normalizes CI evidence before aggregation:

- Check Runs are grouped by case-insensitive context plus producer App identity;
- commit statuses are grouped by case-insensitive context;
- workflow runs are grouped only when a workflow identity is known;
- a record removes an older record only when documented ordering evidence proves it is newer;
- Check Run ordering uses available run timestamps;
- workflow ordering prefers workflow identity + higher run number, then higher run attempt, then documented timestamps;
- records with missing/equal/conflicting ordering evidence remain simultaneously effective;
- different Check producer Apps are never silently collapsed together;
- missing workflow identity never allows unrelated same-name records to be collapsed.

This rule is deliberately fail closed. If duplicate evidence cannot be ordered safely, a failure/running/waiting record may continue to block `PASS`; ambiguity can never manufacture a green state.

`aggregateCiState()` performs the normalization itself even if a future provider also prefilters GitHub responses. Provider behavior is therefore not trusted as the only stale-evidence defense.

## CI aggregation

CI cannot become `PASS` merely because some green evidence exists.

A caller must supply an explicit requirement policy naming the required check contexts and/or workflow names. Without that policy, the result is `WAITING`.

For required Check evidence, GitHub's accepted completed conclusions `success`, `neutral` and `skipped` count as passing evidence. Explicit failure conclusions fail. Active/pending evidence remains running. Cancelled/stale/unknown or otherwise unsupported completion semantics remain conservative rather than being promoted to success.

When a required check is bound to a specific GitHub App/integration ID, only a matching Check producer may satisfy it; a same-context commit status cannot prove the required producer identity.

Aggregation priority is conservative:

1. effective required failure => `FAIL`;
2. effective required active/pending evidence => `RUNNING`;
3. missing or ambiguous required evidence => `WAITING`;
4. `PASS` only when every explicitly required item has passing latest-effective evidence.

An empty requirement list does not manufacture `PASS`.

## Review aggregation

GitHub review responses are treated in chronological order. The latest effective review seen for each actor replaces that actor's earlier review state.

Rules:

- any latest effective `CHANGES_REQUESTED` => `CHANGES_REQUESTED`;
- without an explicit approval requirement => `PENDING`;
- an explicit zero-approval policy => `NOT_REQUIRED`;
- otherwise enough latest effective approvals => `PASS`;
- superseded approval (for example a later `COMMENTED` or `CHANGES_REQUESTED` review by the same actor) is not counted blindly.

Review requirements are derived only from sufficiently complete/representable policy evidence; ambiguous branch-policy coverage remains fail closed.

## Decision projection

An authoritative PR snapshot can be projected into the existing Phase 1 `DecisionReadModel`, proving fixture/live parity without rewriting the mobile UI.

Derived fields include:

- project ID from managed-project policy;
- PR number/title;
- exact current/expected PR head SHA;
- current default-branch SHA;
- changed-file count;
- conservative latest-effective CI/review state;
- reconciliation timestamp.

Fields that GitHub alone cannot authoritatively supply remain external:

- linked issue context is supplied explicitly;
- deploy impact defaults to `UNKNOWN` unless a separate trusted policy projection supplies it;
- required checks/workflows/reviewer thresholds are explicit policy inputs.

## No live Merge capability

A Phase 2 projected decision exposes only `OPEN_PR` in `allowedActions`.

Even when CI + review evidence is sufficient to label the read model `MERGE_READY`, this layer does not grant or execute Merge. Authenticated mutations belong to Phase 3 and require a separately authorized permission expansion and live-state revalidation.

## Sequencing boundary

As rechecked on 2026-08-11, `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md` remains in Phase 3 CV migration. The reviewed #140 controller/readiness host-install proof is complete. Its first incomplete gate is one separately authorized one-shot `AUTO_DEPLOY_SAFE` execution canary against a genuine newer exact-current-main CV delta; classifier issue #151 must also be reconciled before recurring timer activation.

Therefore issue #28 / PR #29 remains source/tests/docs only:

- no GitHub App creation/install/permission change;
- no private key/JWT/installation-token minting;
- no live GitHub transport or `fetch()`;
- no D1/Queue/Workflow binding;
- no Cloudflare production deployment;
- no RPi5/DB/host mutation;
- no AI execution.

A fresh RPi5 sequencing reconciliation is required again at any actual Control live-rollout step.
