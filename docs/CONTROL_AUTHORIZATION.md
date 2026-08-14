# Unified Control authorization

Issue #84 defines the common owner-authorization boundary for future privileged Control operations across the managed repositories.

## One control entry point

The source contract accepts one exact authorization shape:

`authorize control <project-id> workflow_dispatch <exact-main-sha> ci <exact-ci-run-id>`

`project-id` is resolved only through `src/shared/project-policy.ts`. A comment cannot supply an arbitrary repository, workflow path, Cloudflare resource or host target.

The authorization records the exact target repository, expected 40-character lowercase `main` SHA and exact-main CI run ID. A future executor must re-resolve all of that live immediately before mutation; parsing an authorization is never sufficient proof by itself.

## Operation registry

The first registered operation is `workflow_dispatch` because a future Control GitHub App write stage may use a short-lived installation token to dispatch a pre-reviewed workflow in a managed repository.

The registry deliberately records:

- required GitHub permission: `actions:write`;
- target selection: source-controlled allow-list;
- `liveEnabled: false`.

This PR therefore defines the contract only. It does not grant `Actions: write`, mint a token, select a target workflow, dispatch a workflow, create a GitHub Environment/secret, or perform any production mutation.

## Adapter model

Control remains one operator/API surface while production execution stays separated by trust boundary:

- GitHub Actions adapter — dispatch only a source-allow-listed workflow with an exact-repository, short-lived installation token;
- Cloudflare adapter — capability-scoped central credentials such as D1 or Workers, never one broad super-token;
- RPi5 adapter — remains subject to `RPi5_main` production controls; Control must not create a direct SSH/root shortcut.

Unsupported project/operation combinations remain disabled until a focused source change and separate live owner authorization enable them.

## Legacy first-D1 canary

Issue #74 and migration `0001_reconciliation_core.sql` are completed. `.github/workflows/production-d1.yml` remains historical canary infrastructure for now; it is not the generic cross-project dispatcher and must not be treated as reusable authorization for another migration or project.

Production deploy: NO.
Production mutation: NO.
GitHub permission expansion: NO.
