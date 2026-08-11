# Phase 2 GitHub App read rollout plan

Issue: #34  
PR: #36  
Master: #1

## Purpose

Define the source-only least-privilege rollout sequence for the future dedicated `Rozkalns Control` GitHub App. This document authorizes no live App, permission, repository-access, Worker, Cloudflare, or RPi5 change.

## Current sequencing boundary

`RPi5_main#163` completed on 2026-08-11. The current RPi5 Phase 3 first incomplete gate is `RPi5_main#140`: wait for a genuinely newer exact-current-main CV delta that independently classifies `AUTO_DEPLOY_SAFE` with `CONTROL_PLANE_CHANGED=false`, then separately review one one-shot controller canary. The recurring timer remains separately gated.

Control live rollout remains a separate owner decision.

## Official GitHub semantics rechecked 2026-08-11

Current GitHub documentation says Apps should use minimum permissions, repository access can be limited to selected repositories, installation-token scope can be narrowed, active branch rules need `Metadata: read`, and classic branch protection needs `Administration: read`.

The source plan therefore begins with Metadata and does not represent Administration.

## Exact App and repository identity

Future App name:

```text
Rozkalns Control
```

Repository selection mode:

```text
selected
```

The selected repositories are derived from the existing enabled managed-project policy rather than duplicated in the rollout module:

- `rozkalnsandris/hermes-tech`
- `rozkalnsandris/hermes-deals`
- `rozkalnsandris/rozkalns-cv`
- `rozkalnsandris/RPi5_main`
- `rozkalnsandris/ops-workflows`
- `rozkalnsandris/rozkalnsandris`

`rozkalnsandris/hermes-email-skill` remains excluded.

## Staged read plan

The source plan is cumulative and read-only:

1. `metadata-rules` → `metadata: read` → repository metadata + active branch rules;
2. `contents` → add `contents: read` → default-branch commit evidence;
3. `issues` → add `issues: read` → open issues;
4. `pull-requests` → add `pull_requests: read` → PRs, reviews, planned GraphQL merge-state canary;
5. `checks` → add `checks: read` → exact-head Check Runs;
6. `actions` → add `actions: read` → workflow-run/job evidence;
7. `commit-statuses` → add `statuses: read` only when `LEGACY_COMMIT_STATUS_REQUIRED` evidence is explicitly true.

The current repository still has no live GraphQL transport; the GraphQL entry is planning evidence only.

## Deliberately absent

`Administration: read` is not part of the rollout type or plan. Classic branch-protection access remains a separately authorized future gate only if Metadata/active-rules evidence proves insufficient.

Write access is not representable by the rollout plan.

## Scope builder

`buildPhase2GitHubReadScopeForStage()` accepts a positive installation ID, one known stage ID, and explicit evidence for conditional stages. It derives the exact repository set and cumulative read permissions, then delegates validation to the existing installation-read scope parser.

Unknown stages, invalid installation IDs, excluded/drifting repositories, unsupported permissions, or an unsatisfied conditional gate fail closed.

## Regression evidence

Tests prove exact repository selection, metadata-only stage 1, monotonic read-only expansion, GraphQL merge-state planning under the PR stage, conditional commit-status access, absence of Administration/write access, unknown-stage rejection, and source-only isolation from HTTP/auth/Worker configuration.

Source/test CI #94 passed policy checks, runtime audit, typecheck, typed lint, all unit tests, build, and Wrangler dry-run.

## Current runtime boundary

There is still no live Control GitHub App, live permission canary, live GitHub Worker route, Cloudflare rollout, or RPi5/DB/host mutation from this work.

A future live rollout issue must separately authorize the exact App identity, selected repositories, first permission stage, runtime credential configuration, bounded canary, observed evidence, disable/rollback path, and fresh RPi sequencing reconciliation.

## Deploy impact

`DEPLOY_REQUIRED=no`.
