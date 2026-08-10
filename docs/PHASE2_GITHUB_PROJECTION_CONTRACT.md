# Phase 2 GitHub projection and parity contract

Issue: #10  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration, source-only continuation

## Purpose

Define how documented GitHub REST response fields become Rozkalns Control read models without introducing live transport, credentials, mutations or production bindings.

This layer is deliberately pure. A later live adapter may obtain JSON from GitHub, but it must pass that data through the same validation and projection rules before the UI can consume it.

## Fail-closed payload mapping

The REST mapper consumes only fields that Rozkalns Control currently needs:

- repository: `full_name`, `default_branch`;
- pull request: number/title/state/draft, base ref+SHA, head ref+SHA, changed-file count and HTML URL;
- review: id/state/actor/submission timestamp;
- check run: id/name/status/conclusion/head SHA/details URL;
- workflow run: id/name/status/conclusion/head SHA/HTML URL;
- issue: number/title/state/HTML URL.

Missing critical fields or unsupported enum values throw instead of silently defaulting.

Current check-run status handling includes GitHub's pending-like states (`waiting`, `requested`, `pending`) in addition to `queued`, `in_progress` and `completed`. Pending-like states never imply success.

## Exact-head evidence

Check/workflow evidence is useful only when its `head_sha` equals the currently observed pull-request head SHA.

The source layer therefore has two protections:

1. mapper helpers can discard evidence from another head SHA;
2. authoritative snapshot projection reasserts exact-head equality and throws if mixed evidence reaches it.

Branch name alone is never sufficient evidence.

## CI aggregation

CI cannot become `PASS` merely because some green evidence exists.

A caller must supply an explicit requirement policy naming the check runs and/or workflow runs that count. Without that policy, the result is `WAITING`.

Priority is conservative:

1. required failure => `FAIL`;
2. required active/pending evidence => `RUNNING`;
3. missing, cancelled, skipped, neutral, stale or otherwise ambiguous required evidence => `WAITING`;
4. `PASS` only when every explicitly required item has considered successful completed evidence.

An empty requirement list does not manufacture `PASS`.

## Review aggregation

GitHub review responses are treated in chronological order. The latest effective review seen for each actor replaces that actor's earlier review state.

Rules:

- any latest effective `CHANGES_REQUESTED` => `CHANGES_REQUESTED`;
- without an explicit approval requirement => `PENDING`;
- an explicit zero-approval policy => `NOT_REQUIRED`;
- otherwise enough latest effective approvals => `PASS`;
- superseded approval (for example a later `COMMENTED` or `CHANGES_REQUESTED` review by the same actor) is not counted blindly.

This source-only phase does not attempt to infer branch-protection/reviewer policy from GitHub configuration.

## Decision projection

An authoritative PR snapshot can be projected into the existing Phase 1 `DecisionReadModel`, proving fixture/live parity without rewriting the mobile UI.

Derived fields include:

- project ID from managed-project policy;
- PR number/title;
- exact current/expected PR head SHA;
- current default-branch SHA;
- changed-file count;
- conservative CI/review state;
- reconciliation timestamp.

Fields that GitHub alone cannot authoritatively supply remain external:

- linked issue context is supplied explicitly;
- deploy impact defaults to `UNKNOWN` unless a separate trusted policy projection supplies it;
- required checks/workflows/reviewer thresholds are explicit policy inputs.

## No live Merge capability

A Phase 2 projected decision exposes only `OPEN_PR` in `allowedActions`.

Even when CI + review evidence is sufficient to label the read model `MERGE_READY`, this layer does not grant or execute Merge. Authenticated mutations belong to Phase 3 and require a separately authorized permission expansion and live-state revalidation.

## Sequencing boundary

As of 2026-08-10, `RPi5_main/docs/AUTOMATION_MASTER_PLAN.md` remains in Phase 3 CV migration with an incomplete maintenance/`cvbot` health prerequisite.

Therefore this work remains source/tests/docs only:

- no GitHub App creation/install/permission change;
- no private key/JWT/installation token path;
- no live GitHub transport;
- no D1/Queue/Workflow binding;
- no Cloudflare production deployment;
- no RPi5/DB/host mutation;
- no AI execution.
