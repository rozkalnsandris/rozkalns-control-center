# Phase 2 GitHub merge-state contract

Issue: #12  
Master: #1  
Phase: Phase 2 — live read-only GitHub integration, source-only continuation

## Purpose

Prevent Rozkalns Control from reporting a live pull request as `MERGE_READY` merely because locally configured CI/review evidence looks green.

GitHub remains authoritative for the actual pull-request merge state. The Phase 2 read model therefore adds a separate merge-state evidence record bound to the exact pull-request number and head SHA.

## Current official GitHub basis — rechecked 2026-08-10

GitHub GraphQL documents `PullRequest.mergeStateStatus` as detailed pull-request merge-state information. The documented states currently include:

- `BEHIND`;
- `BLOCKED`;
- `CLEAN`;
- `DIRTY`;
- `DRAFT`;
- `HAS_HOOKS`;
- `UNKNOWN`;
- `UNSTABLE`.

For this Control contract, only `CLEAN` may contribute to a ready projection, and only when GraphQL `mergeable` is also `MERGEABLE`.

GitHub documents GraphQL App permissions differently from REST: the intended query must be proven with the real dedicated Control App before live rollout. This source-only phase does not assume a permission that has not been canary-tested.

The REST `Get branch protection` endpoint currently requires Repository `Administration: read`. Adding that permission merely to infer required checks/reviews would broaden the future App permission set, so this issue does not introduce it.

## Exact-head evidence contract

A merge-state read contains only the fields Control needs:

- pull-request number;
- exact `headRefOid` / head SHA;
- `mergeable`;
- `mergeStateStatus`;
- draft state.

The authoritative snapshot fails closed when any of these disagree with the separately observed pull-request record:

- pull-request number mismatch;
- head SHA mismatch;
- draft-state mismatch.

Check-run and workflow-run evidence remains independently bound to the same head SHA.

## Readiness truth table

`MERGE_READY` is possible only when all of the following are true at the same authoritative reconciliation:

1. pull request is open and not draft;
2. required CI projection is `PASS`;
3. required review projection is `PASS`;
4. merge evidence is for the same PR and exact head SHA;
5. GitHub `mergeable` is `MERGEABLE`;
6. GitHub `mergeStateStatus` is exactly `CLEAN`.

Every other merge-state value is non-ready:

| GitHub state | Control behavior |
| --- | --- |
| `CLEAN` + `MERGEABLE` | may be `MERGE_READY` if all other evidence passes |
| `BEHIND` | `WAITING` |
| `BLOCKED` | `WAITING` |
| `DIRTY` / `CONFLICTING` | `WAITING` |
| `DRAFT` | `WAITING` |
| `HAS_HOOKS` | `WAITING` until a later contract proves safe semantics |
| `UNKNOWN` | `WAITING` |
| `UNSTABLE` | `WAITING` |
| unknown future enum | mapper rejects the payload |

This is deliberately more conservative than GitHub's UI. Phase 2 has no write action, so false negatives are acceptable; false readiness is not.

## Permission boundary

This change does **not**:

- create or install a GitHub App;
- request `Administration: read`;
- add a GraphQL or REST client;
- generate JWTs or installation tokens;
- add credentials or Cloudflare bindings;
- add GitHub mutation methods;
- enable a Merge button;
- touch RPi5, production, DB or host state.

The future live GraphQL query and its exact dedicated-App permissions require a separate rollout gate and real permission canary.

## Source-only validation

CI must prove:

- every currently documented merge-state enum has deterministic behavior;
- only `MERGEABLE/CLEAN` can satisfy the merge-state readiness gate;
- wrong PR/head/draft evidence fails closed;
- unknown enum values fail closed;
- source-only files contain no live transport/auth/mutation path;
- the existing Phase 1 UI read-model shape remains unchanged.

## Deploy impact

`DEPLOY_REQUIRED=no`.

This document and its associated source/tests do not authorize any live GitHub, Cloudflare or RPi5 rollout.
