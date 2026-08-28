# Phase 3 Later decision contract

Status: **source-wired / capability disabled**.

This document defines the bounded operator-facing `Later` action, its durable D1 persistence/idempotency boundary, and the authenticated Worker route/runtime source composition. No project currently has `canLater=true`, so the route remains fail-closed before persistence and no live Later action is activated.

## Product meaning

`Later` is a deferral, not an approval or rejection. It must not authorize Merge, Needs changes, deploy, DB migration/apply, host mutation or any other privileged action.

For one exact normalized decision state, an authenticated runtime may persist a Later deferral and suppress repeated operator attention while that material state remains unchanged. A materially changed decision must require a fresh Later action.

## Pure decision contract

`src/shared/later-decision.ts` provides:

- `createLaterDeferral(...)` — requires normalized `LATER` authority and creates bounded evidence with a deterministic material-state fingerprint;
- `evaluateLaterDeferral(...)` — distinguishes `DEFERRED_UNCHANGED` from `RELEASE_MATERIAL_CHANGE` without I/O.

Material state includes decision/project identity, workflow/CI/review/deploy state, issue/PR identity, changed-file count, expected/current head, main SHA, reason and normalized action authority. Reconciliation timestamps and display-only title/link changes are intentionally non-material.

## Persistence contract

`src/shared/later-deferral-store.ts`, `src/integrations/cloudflare/d1-later-deferral-store.ts` and `migrations/0009_later_deferrals.sql` define one active deferral per decision identity.

The D1 adapter uses prepared/bound statements and exact D1 `meta.changes` checks:

- first state: `CLAIMED`;
- exact replay: `REPLAY`, preserving original persisted evidence;
- conflicting state: `CONFLICT`;
- deliberate materially changed state: explicit compare-and-swap `REPLACED / REPLAY / CONFLICT`.

There is no blind overwrite. The migration stores bounded decision evidence and actor audit identity only; it excludes Access JWTs, GitHub tokens, private keys, secrets, raw request bodies and webhook payloads.

`0009_later_deferrals.sql` is merged source only. It has **not** been applied to remote production D1.

## Authenticated action executor

`src/shared/later-action.ts` is the source-level decision/persistence composition. It does not trust caller-supplied decision state.

For every request it:

1. records one exact observation timestamp;
2. re-reads a fresh normalized live dashboard through the existing GitHub read runtime;
3. resolves the exact managed project and decision identity;
4. requires the fresh decision to still expose `LATER` in `allowedActions`;
5. recomputes the material Later state fingerprint;
6. requires it to exactly equal the caller's `expectedStateFingerprint`;
7. only then calls the durable store;
8. claims a first deferral, replays an exact duplicate idempotently, or performs an explicit store CAS replacement after material state change.

A stale fingerprint fails before persistence with `AUTHORIZATION_STALE_STATE`. Missing fresh authority fails with `ACTION_NOT_ALLOWED`. Upstream live-read uncertainty fails closed as `RECONCILIATION_FAILED`.

## Cloudflare Access authentication

`src/worker/github-later-runtime.ts` reuses the repository's existing `CloudflareAccessRequestAuthenticator` rather than implementing a new JWT parser.

The reviewed pattern follows current Cloudflare Access guidance:

- read the Access application token from `Cf-Access-Jwt-Assertion`;
- cryptographically verify the signature against the remote Access JWKS/signing keys;
- verify the expected Access issuer;
- verify the exact Access application audience (`aud`);
- fail closed if the token, key, issuer, audience or claims are invalid.

Source bindings:

- `CONTROL_LATER_ACCESS_ISSUER`;
- `CONTROL_LATER_ACCESS_AUDIENCE`.

They intentionally match the existing Control Access application identity already used by Merge and Needs changes. Adding these source vars does not mutate the Cloudflare Access application or its policy.

## Worker route contract

`POST /api/github/later` is registered in Worker source through `src/worker/index.ts`.

The request body is intentionally small and strict:

```json
{
  "repository": "owner/repository",
  "decisionId": "normalized-decision-id",
  "expectedStateFingerprint": "later-v1-0123456789abcdef"
}
```

The route rejects:

- wrong path or method;
- query strings;
- non-JSON content types;
- oversized bodies;
- unknown/extra/malformed fields;
- missing/invalid Access authentication;
- repositories without explicit `canLater=true`.

Responses are `Cache-Control: no-store`.

## Double capability gate

`canLater` is a dedicated project capability in `src/shared/project-policy.ts`.

All six managed projects currently have:

```text
canLater=false
```

The capability is checked twice:

1. `github-later-route.ts` checks before calling runtime execution;
2. `github-later-runtime.ts` calls `requireLaterProjectPolicy(...)` again before fresh GitHub reads or D1 access.

Therefore the source route can exist in `main` without activating a live Later decision path. With every project disabled, requests stop at `ACTION_NOT_ALLOWED` before Later persistence. Any future `canLater=true` change is a separate deliberate capability/trust-boundary activation and must not be inferred from source merge or deploy.

## UI boundary

React remains unchanged and demo-only for `Later`. There is no `/api/github/later` fetch/network caller in the UI.

UI activation must only be considered after the backend prerequisites are intentionally activated and canaried.

## Future gates

The sequence remains split:

1. pure Later decision contract — **merged**;
2. durable D1 persistence/idempotency source boundary — **merged**;
3. authenticated Worker route/runtime source composition — **current source slice**;
4. remote `0009_later_deferrals.sql` apply — separate explicit owner-gated production DB mutation;
5. deliberate selected-project `canLater=true` capability activation — separate reviewed gate;
6. production Worker rollout and bounded backend canary — separate explicit owner-gated live gate;
7. React `Later` network activation — separate source/live gate after backend evidence;
8. reminder/re-notification policy — separate product/source decision.

Ordering of steps 4-6 must be freshly reviewed immediately before live activation so the route cannot reach a missing table. Source merge alone authorizes none of them.

## Current classification

- Production deploy: **NO** for this source PR.
- Source migration 0009: **already merged**.
- Remote D1 migration/apply: **NOT DONE**.
- `canLater=true`: **NONE**.
- Cloudflare Access policy/DNS/Tunnel/secret mutation: **NO**.
- GitHub App permission/repository-selection growth: **NO**.
- Runtime/host mutation: **NO**.
- UI Later activation: **NO**.
- Live Later action: **NO**.
