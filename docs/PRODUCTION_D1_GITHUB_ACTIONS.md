# Production D1 GitHub Actions gate

This document defines the source-controlled GitHub Actions execution path for privileged Rozkalns Control D1 migrations.

It does **not** authorize creation of a GitHub Environment, creation/storage of a Cloudflare token, workflow execution, D1 mutation, Queue/DLQ work, webhook activation, Worker deployment, traffic routing, Access changes, GitHub permission expansion, or host mutation.

## Purpose

The production D1 gate is centralized in:

- workflow: `.github/workflows/production-d1.yml`;
- controller: `scripts/cloudflare-d1-migration-gate.mjs`;
- GitHub Environment: `production`;
- environment secret: `CLOUDFLARE_D1_MIGRATION_TOKEN`.

The normal `.github/workflows/ci.yml` remains source validation only and receives no production Cloudflare credential.

## Credential boundary

Do not store the broad temporary `rozkalns-control-setup` token in GitHub Actions.

A separately authorized live setup step may create one dedicated Cloudflare API token for this implemented automation with:

- exact Rozkalns Control Cloudflare account scope;
- D1 Write only;
- no Workers Scripts, Queues, Access, DNS, Routes, Zone, API Tokens, Billing or unrelated product permission.

Cloudflare currently requires D1 Write for D1 database writes. The controller independently pins the exact production database name, UUID and jurisdiction because the API-token resource scope is the account boundary, not a substitute for application-level database identity checks.

The dedicated token is a control-plane automation credential, not a Worker runtime credential. Store it only as the `production` Environment secret named `CLOUDFLARE_D1_MIGRATION_TOKEN`.

## GitHub Environment live setup

Environment creation/configuration is a separate live trust-boundary change after the source PR merges and exact-main CI passes.

Required configuration:

1. environment name exactly `production`;
2. deployment branch/tag policy restricted to branch `main`;
3. secret name exactly `CLOUDFLARE_D1_MIGRATION_TOKEN`;
4. secret value is the dedicated D1-only token, never the broad setup token;
5. no unrelated production secret is added for this workflow.

A required reviewer may be added as extra hardening, but the workflow's mandatory owner dispatch plus exact authorization input remains the project authorization signal. Environment protection must never weaken the source checks.

## Manual dispatch contract

`Production D1 Migration` is `workflow_dispatch` only. It has no push, pull-request, schedule or repository-dispatch trigger.

The owner provides three required inputs:

- `expected_sha` — exact current `main` SHA;
- `expected_ci_run_id` — exact successful `CI` push run for that SHA;
- `owner_authorization` — exact one-shot authorization string accepted by the source controller.

Inputs are mapped to environment variables and passed as quoted command arguments. They are not interpolated into executable shell syntax.

## GitHub-hosted execution context

The controller allows the GitHub Actions path only when GitHub's non-overridable default runner variables prove all of the following:

- repository is `rozkalnsandris/rozkalns-control-center`;
- event is `workflow_dispatch`;
- ref is `refs/heads/main`;
- `GITHUB_SHA` equals the authorized SHA;
- workflow name is `Production D1 Migration`;
- workflow ref is `rozkalnsandris/rozkalns-control-center/.github/workflows/production-d1.yml@refs/heads/main`;
- workflow-file SHA equals the authorized SHA;
- job is `migrate`;
- runner environment is `github-hosted`;
- initiating actor is the repository owner identity pinned in source;
- run attempt is exactly `1`;
- source workflow marks the execution environment as `production`.

The existing trusted local `lenovo` path remains supported. Other local hosts and self-hosted GitHub runners fail closed.

## Source, CI and resource binding

Before D1 write the controller still requires:

- exact authorized SHA format and CI run ID;
- clean exact repository checkout;
- `origin/main` still equals the authorized SHA;
- exact successful `CI` push run on that SHA;
- pinned Node/Wrangler source contract;
- exact reviewed migration set and SHA-256;
- exact D1 binding/resource identity;
- GET/SELECT-only D1 prewrite evidence;
- exact one-shot owner authorization.

The GitHub Actions workflow does not replace these checks; it only supplies a centralized execution context and isolated credential.

## No-blind-retry rules

Workflow concurrency is fixed to one `production-d1-migration` group with `cancel-in-progress: false` so a newer dispatch does not cancel an active production migration.

GitHub workflow reruns are rejected by the controller when `GITHUB_RUN_ATTEMPT != 1`.

When the controller emits:

```text
APPLY_STARTED=YES
AUTHORIZATION_CONSUMED=YES
```

the one-shot authorization is consumed. Any later error requires read-only reconciliation before a new owner authorization. Do not use GitHub's Re-run button as a retry mechanism.

## Current migration state

Issue #74 already completed `0001_reconciliation_core.sql` successfully on production. Its authorization is consumed and must never be reused.

Therefore merging this source workflow does **not** authorize or require an immediate production workflow run. A future live D1 execution must first have a reviewed unapplied migration/controller state, fresh exact-main CI and a new explicit owner authorization.

## Live setup/run sequence after source merge

1. Verify new exact `main` and exact-main push CI.
2. Separately authorize creation/configuration of the `production` GitHub Environment and dedicated D1-only Cloudflare token.
3. Verify the environment branch policy and secret name without exposing the secret value.
4. STOP before workflow execution unless a concrete unapplied migration is reviewed and separately authorized.
5. For an authorized run, enter exact SHA, exact CI run ID and exact one-shot authorization in the manual workflow form on `main`.
6. Observe the run. If `APPLY_STARTED=YES` appears, never rerun after failure without reconciliation.
7. Record sanitized postverify evidence in the live gate issue.

## Security / deploy impact

- Production deploy: **NO** for this source change.
- Production mutation: **NO** for this source change.
- GitHub permission expansion: **NO**; workflow token permissions are `contents: read`.
- Cloudflare secret creation: **NO** until separately authorized.
- Workflow execution: **NO** until separately authorized.
