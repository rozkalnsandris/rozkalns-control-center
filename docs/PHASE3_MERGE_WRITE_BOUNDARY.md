# Phase 3 dormant pull-request Merge write boundary

Status: source-only / dormant. Rechecked against GitHub REST documentation on 2026-08-24.

## Purpose

This boundary prepares the low-level GitHub primitives required for the operator-first `Merge` action without activating any live Merge capability. It deliberately stops below Worker routing, UI wiring, project capability enablement, GitHub App permission expansion, production deployment and live merge execution.

## GitHub contract

The GitHub REST endpoint is:

```text
PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge
```

For a GitHub App installation access token, this endpoint requires repository `Contents: write` permission. The request may carry:

```json
{
  "sha": "<exact-current-approved-head-sha>",
  "merge_method": "merge|squash|rebase"
}
```

The `sha` field is mandatory in the Rozkalns Control boundary even though GitHub makes it optional generally. This binds the write to the exact head already approved by Control. GitHub documents `409 Conflict` when the supplied expected head SHA does not match the pull request's current head.

Rozkalns Control never converts that conflict into an automatic refresh-and-retry. A changed head requires a new authoritative read, a new decision and a new explicit human authorization at the future live layer.

## Writer boundary

`src/integrations/github/pull-request-merge-write.ts`:

- accepts only a managed repository;
- requires a positive pull number;
- requires an exact lowercase 40-hex expected head SHA;
- admits only explicit `merge`, `squash` or `rebase` methods;
- normalizes the observation time before credential acquisition;
- requests a session scoped as `contents:write`;
- creates one exact GitHub `PUT .../pulls/{n}/merge` request with `sha` + `merge_method` and no additional body keys;
- maps 409 to bounded `HEAD_CONFLICT`;
- treats transport failures or malformed success evidence as non-retryable `WRITE_OUTCOME_UNKNOWN`;
- accepts success only when GitHub returns `merged=true` and a bounded exact merge SHA.

No automatic retry exists in this writer.

## Installation session boundary

`src/integrations/github/app-installation-merge-session.ts` mints a short-lived installation credential for exactly one managed repository with:

```json
{
  "repositories": ["<exact-repository-name>"],
  "permissions": {
    "contents": "write"
  }
}
```

Returned credential evidence must contain exactly that repository and exactly `contents: write`, with GitHub's `metadata: read` allowed as the sole optional additional permission evidence. Broader scopes fail closed.

The opaque credential:

- is never exported in the returned lease;
- is injected only into the one validated GitHub Merge request;
- is not assumed to have a fixed prefix or legacy length;
- belongs to a single-use authorized session.

The session validates exact GitHub origin, path, HTTP method, REST API version, content type, redirect policy, required permission and exact body keys before it consumes the one-shot session.

## Dormant safety boundary

Issue #388 intentionally does **not** add any of the following:

- `canMerge` project policy capability;
- Worker Merge route/runtime;
- Merge button or UI event;
- D1 merge audit schema/runtime;
- GitHub App `Contents: write` permission change;
- repository-selection expansion;
- Cloudflare binding or Worker configuration change;
- production deployment;
- live GitHub merge.

The new modules remain unreachable from deployed runtime source until a separately reviewed source unit wires them.

## Future gates

Before any real Merge action can exist in production, all of these remain separate gates:

1. **Permission trust gate** — explicit owner authorization to expand the dedicated Rozkalns Control GitHub App to the minimum required `Contents: write` permission, with exact repository selection revalidated.
2. **Authoritative pre-write gate** — live PR state/head/base/CI/review/policy evidence must be re-resolved immediately before each merge and bound to the approved exact head.
3. **Audit/idempotency design** — persist enough bounded evidence to distinguish not-started, terminal success/failure and ambiguous write outcome without blind retry.
4. **Authenticated Worker route/runtime wiring** — separate source PR; fail closed; no generic remote execution surface.
5. **UI capability gate** — only after backend canary evidence; no green Merge action based on cached state.
6. **Production rollout** — separately authorized exact-SHA deploy after source merge and fresh production preflight.
7. **Live canary** — one separately authorized disposable target only; no retries after a write begins without fresh reconciliation and authorization.

## Deployment classification for #388

`Production deploy: NO`.

The #388 source unit adds only dormant, unreferenced GitHub integration primitives, tests and this documentation. It does not change Worker entrypoints, runtime wiring, `wrangler.jsonc`, project capabilities or UI behavior.
