# Unified production authorization model

This document defines the source-only authorization and operation-registry contract introduced by issue #84. It does not grant any live permission, create a secret, dispatch a workflow, mutate Cloudflare, mutate RPi5 or deploy anything.

## Goal

Rozkalns Control should use one central owner-authorization entry point rather than repository-specific permanent credentials or ad-hoc command formats.

The authority boundary is intentionally split:

1. authenticate the human/owner at the entry point;
2. parse one exact authorization string;
3. resolve the operation ID against the source-controlled registry;
4. derive repository/workflow/resource only from that registry, never from arbitrary comment input;
5. re-read exact target `main` SHA and exact-main CI immediately before any future mutation;
6. acquire only the credential capability required by the resolved executor;
7. execute through the trust-boundary adapter;
8. verify the result and record bounded evidence.

Parsing a string is never sufficient authority by itself.

## Canonical command shape

Future Control operations use:

`authorize control <operation-id> <exact-main-sha> ci <exact-ci-run-id>`

The authorization text intentionally does **not** accept repository names, workflow filenames, Cloudflare resource IDs, host names or arbitrary executor inputs. Those values must come from reviewed source.

The syntax parser accepts only:

- one source-controlled operation ID;
- one 40-character lowercase hexadecimal SHA;
- one positive integer CI run ID;
- no leading/trailing text or additional arguments.

The owner identity must be authenticated separately by the eventual entry point.

## Operation registry

`src/shared/production-authorization.ts` is the first reusable registry contract.

Every operation records:

- stable operation ID;
- managed project ID;
- exact repository;
- executor trust boundary;
- lifecycle state (`disabled`, `enabled`, or `retired`);
- whether exact-main SHA and exact-main CI are mandatory;
- executor-specific target data and permission contract.

### Default state

All managed-project GitHub workflow-dispatch operations are currently present only as **disabled placeholders**. They have no workflow target. This is deliberate: a later focused source PR must define the exact workflow file/ref/input allow-list before any operation can become executable.

No workflow-dispatch operation is enabled by issue #84.

### Retired first D1 canary

The completed #74 first-production-D1 operation is represented as:

`control.initial-production-d1-migration`

with lifecycle state `retired`.

The old `.github/workflows/production-d1.yml` no longer accepts issue-comment authorization and contains no production Environment or secret reference. It exists only as a disabled historical marker. The consumed #74 authorization must never be replayed.

## GitHub workflow-dispatch permission contract

GitHub's current REST documentation states that `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` accepts GitHub App installation access tokens and requires repository permission **Actions: write**.

GitHub also documents that installation access tokens:

- expire after one hour;
- may be narrowed to selected `repositories` / `repository_ids`;
- may be narrowed to selected `permissions`;
- cannot gain repository access or permissions that the GitHub App installation itself does not have.

Therefore the future dispatch adapter contract is:

- dedicated `Rozkalns Control` GitHub App only;
- exact target repository from the source registry;
- installation token narrowed to that repository where supported;
- requested token permission narrowed to `actions: write` for dispatch;
- exact workflow file/ref/input allow-list from source;
- exact-main SHA + exact-main CI revalidated immediately before dispatch;
- no Contents write merely to dispatch a workflow;
- no PAT.

This document defines the **required future permission**, but issue #84 does **not** authorize changing the live App permission to Actions write.

## Executor boundaries

The registry distinguishes trust boundaries rather than giving each repository its own credential model:

- `github-actions-dispatch` — future GitHub App installation-token adapter;
- `cloudflare-d1` — Cloudflare control-plane/D1 adapter;
- `rpi5-controller` — RPi5-owned production adapter.

An operation may only execute through the adapter declared in reviewed source. Arbitrary executor selection from user/comment input is forbidden.

## Fail-closed rules

Resolution must fail closed when:

- authorization syntax is malformed;
- operation ID is unknown;
- operation is `disabled`;
- operation is `retired`;
- target repository/workflow/resource is not present in source;
- expected SHA or CI evidence is stale/mismatched;
- required credential permission is absent;
- mutation result is ambiguous.

After any future mutation boundary has been crossed, no blind retry is allowed without operation-specific reconciliation and a new owner authorization.

## Explicitly outside this source increment

Not performed or authorized here:

- GitHub App permission expansion;
- GitHub Environment or secret creation/change;
- workflow dispatch;
- Cloudflare mutation;
- D1 write;
- Queue/DLQ/webhook activation;
- Worker deploy or traffic/routing change;
- RPi5/host/root mutation;
- merge/deploy coupling;
- AI execution.

## Official GitHub references rechecked 2026-08-14

- REST workflows — Create a workflow dispatch event: https://docs.github.com/en/rest/actions/workflows
- Authenticating as a GitHub App installation: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- REST GitHub Apps — Create an installation access token: https://docs.github.com/en/rest/apps/apps

Production deploy: **NO**.
Production mutation: **NO**.
GitHub permission expansion: **NO**.
