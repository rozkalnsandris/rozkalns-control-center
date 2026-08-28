# Phase 3 Later decision contract

Status: **source-wired / canary capability prepared / UI source-wired / live activation separately gated**.

`Later` is a deferral, not an approval or rejection. It must not authorize Merge, Needs changes, deploy, DB migration/apply, host mutation or any other privileged action.

## Source contracts

`src/shared/later-decision.ts` creates/evaluates deterministic material-state fingerprints. `src/shared/later-deferral-store.ts`, `src/integrations/cloudflare/d1-later-deferral-store.ts` and `migrations/0009_later_deferrals.sql` define bounded claim/replay/conflict and compare-and-swap persistence. There is no blind overwrite. Remote production D1 migration `0009` is **not applied**.

`src/shared/later-action.ts` re-reads fresh normalized live GitHub state, requires fresh `LATER` authority and an exact recomputed fingerprint before persistence. `POST /api/github/later` remains Access-authenticated and route/runtime capability-gated.

## Selected source canary policy

The only managed repository prepared with `canLater=true` in source is `rozkalnsandris/ops-workflows`. The other five remain `canLater=false`. All managed repositories remain `canMerge=false`.

This source capability change is not production activation and is not permission to issue a live Later request.

## React decision-action source boundary

React source uses one typed same-origin client for `/api/github/merge`, `/api/github/needs-changes` and `/api/github/later`. Mutating buttons appear only from fresh `LIVE` normalized dashboard state; fixture/loading/refreshing/disabled/stale states suppress them.

Every mutating action requires a second explicit confirmation. Merge explicitly confirms `squash`; Needs changes requires a non-empty message and enforces the server's 4096 UTF-8 byte bound; Later sends `laterDecisionStateFingerprint(...)` for the exact rendered decision. Merge and Needs changes bind exact issue/PR/head/main evidence and a fresh bounded request ID. A synchronous in-flight lock prevents duplicate submit. After success or failure, the UI refreshes `/api/github/dashboard`; local action responses are never canonical state.

The Worker remains authoritative: UI source cannot bypass Access authentication, project capability gates, fresh reconciliation, stale-state checks, idempotency or persistence/write contracts.

## Future live ordering — not authorized by source merge

For Later:

```text
remote 0009 apply
→ exact Worker version upload/verification
→ exact version deploy
→ bounded authenticated Later backend canary
→ only then rely on production UI Later
```

Merge and Needs changes retain their own independent permission/backend-canary requirements.

## Current classification

- Production deploy: **NO** for the source PR.
- Source migration `0009`: **already merged**.
- Remote D1 migration/apply: **NOT DONE / separately owner-gated**.
- Source `canLater=true`: **only `rozkalnsandris/ops-workflows`**.
- Production Worker rollout: **NOT DONE / separately owner-gated**.
- Bounded Later backend canary: **NOT DONE**.
- Production UI action use: **NOT ACTIVATED**.
- GitHub App permission/repository-selection growth: **NO**.
- Cloudflare Access/DNS/Tunnel/secret mutation: **NO**.
- Runtime/host mutation: **NO**.
- Live Later action: **NO**.

Source merge alone authorizes none of the remote migration, rollout, backend canary, production action, permission or trust-boundary steps above.
