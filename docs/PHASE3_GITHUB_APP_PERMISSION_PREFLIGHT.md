# Phase 3 — GitHub App permission activation preflight

Status: **source-only / read-only activation prerequisite**.

This document defines the evidence required before Rozkalns Control may even ask the owner to authorize the first Phase 3 GitHub App write-permission change.

## Current live boundary

At this source baseline:

- the dedicated GitHub App is `Rozkalns Control`;
- App ID: `4567356`;
- Client ID: `Iv23likDoFtVeWBJfdFS`;
- Installation ID: `153121564`;
- installation owner: `rozkalnsandris`;
- selected managed repositories are exactly `hermes-tech`, `hermes-deals`, `rozkalns-cv`, `RPi5_main`, `ops-workflows`, `rozkalnsandris`;
- `hermes-email-skill` is explicitly excluded;
- reviewed current repository permissions are exactly `Metadata: read`, `Contents: read`, `Issues: read`, `Pull requests: read`, `Checks: read`, `Actions: read`;
- all project `canRequestChanges` capabilities remain false;
- the detached Needs-changes handler/runtime is not registered in `src/worker/index.ts`;
- production Wrangler config contains no Needs-changes activation flag or Access issuer/audience for this route.

Production D1 migration `0002_needs_changes_audit.sql` being present does not authorize GitHub permission growth or a Worker write route.

## Why the preflight has two credential shapes

GitHub's current REST contract requires a GitHub App JWT for App/installation identity endpoints. The JWT is signed with RS256 and uses the App client ID as issuer.

The installation object exposes the installation permission map and selected/all repository mode, but exact enumeration of repositories accessible to the installation uses the installation-authenticated repository-list endpoint. Therefore OBSERVE may issue one ephemeral installation token constrained to **`metadata: read` only** and no repository subset so the complete selected repository set can be enumerated.

That token:

- carries no write permission;
- is never printed or persisted by the helper;
- is used only for `GET /installation/repositories?per_page=100&page=1`;
- is allowed to expire naturally;
- does not change App permissions, repository selection, repository content or Worker state.

No write-capable installation token is permitted in this preflight.

## Helper

Package entry point after this slice:

```text
npm run github:needs-changes-preflight -- ...
```

Underlying script:

```text
scripts/github-app-needs-changes-preflight.mjs
```

### PLAN

Default PLAN is credential-free and non-mutating:

```text
npm run github:needs-changes-preflight -- --mode plan
```

PLAN prints only pinned public identity, current expected read-only permissions, managed/excluded repository names, the proposed future permission delta, and explicit `NO` markers for permission growth, Worker deploy and capability enablement.

PLAN never reads the private key and never calls GitHub.

### OBSERVE

OBSERVE is local-owner-only and read-only with respect to GitHub/App/repository configuration. It requires:

- host `lenovo`;
- not GitHub Actions;
- clean local branch `main`;
- exact local HEAD supplied with `--expected-sha`;
- fresh `origin/main` equal to that SHA;
- exact successful `main` push CI supplied with `--expected-ci-run-id`;
- `GITHUB_APP_PRIVATE_KEY_PEM` supplied locally without printing it.

OBSERVE performs:

1. public GET of the exact main CI run and requires that exact run/SHA to be `completed/success`;
2. reads and validates the GitHub API `Date` header from that same exact-main CI response and uses it as the App-JWT clock source;
3. creates the App JWT with `iat = GitHub server time - 60s` and a conservative `exp = GitHub server time + 5m` window;
4. App-JWT `GET /app`;
5. App-JWT `GET /app/installations/153121564`;
6. App-JWT repository-installation GET for every required managed repository;
7. App-JWT repository-installation GET for `hermes-email-skill`, which must be 404;
8. one `POST /app/installations/153121564/access_tokens` requesting exactly `{metadata: read}` and no repository narrowing, only to enumerate the installation's complete selected repository set;
9. metadata-only token `GET /installation/repositories?per_page=100&page=1`;
10. exact repository-set and permission comparison;
11. sanitized PASS/FAIL output.

No extra endpoint is called solely to obtain time. Missing or malformed GitHub `Date` evidence fails closed before the first App-JWT request. This avoids depending on the Lenovo wall clock for live App authentication while preserving the exact-main CI gate.

Any identity, permission, suspension, selected-repository, CI or server-time drift fails closed.

## Proposed future permission delta

The only permission delta this preflight may describe is:

```text
pull_requests: read -> write
```

It may not propose or authorize:

- `Contents: write`;
- `Administration` permission;
- Actions/Checks/Issues write;
- repository-selection growth;
- user OAuth permission;
- event-subscription growth;
- any unrelated repository permission.

## Still separate owner gates

Even a successful OBSERVE is evidence only. It does **not** authorize:

1. changing the GitHub App registration to `Pull requests: write`;
2. accepting/refreshing installation permission changes;
3. minting a write-capable installation token;
4. registering `/api/github/needs-changes` in the production Worker;
5. restoring trusted Access issuer/audience runtime config for that route;
6. deploying the Worker;
7. setting any project `canRequestChanges=true`;
8. sending a live `REQUEST_CHANGES` review;
9. enabling the UI action.

Those steps remain separately reviewed, exact-SHA-bound and owner-authorized. Permission growth must happen before a write-token canary, and route/config/deploy activation must not be silently bundled into the same authorization.

## Security invariants

- private key, App JWT and installation token never enter GitHub issues, PRs, D1 or logs;
- raw upstream response bodies and exception text are not emitted on failure;
- API redirects are not followed;
- live OBSERVE App-JWT timing is anchored to the validated GitHub server `Date`, not the local Lenovo wall clock;
- live OBSERVE JWT lifetime is 5 minutes from validated GitHub server time, with `iat` backdated 60 seconds;
- repository inventory token is metadata-read-only;
- unknown/drifted permission or repository state fails closed;
- all six `canRequestChanges` flags stay false in this slice;
- no production route/config/deploy change is part of this slice.

**Production deploy: NO. Production mutation: NO.**
