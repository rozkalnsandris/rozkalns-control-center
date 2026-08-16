# Phase 3 — guarded `Needs changes` review boundary

Status: **source-only, detached Worker boundary**.

This Phase 3 chain defines the `Needs changes` / GitHub `REQUEST_CHANGES` action without activating a production mutation path or broadening the production GitHub App.

## Why `Needs changes` is first

GitHub's current REST `Create a review for a pull request` endpoint supports GitHub App installation access tokens, requires `Pull requests: write`, accepts an explicit `commit_id`, and supports `event=REQUEST_CHANGES`.

The REST merge endpoint requires `Contents: write`. Rozkalns Control explicitly keeps source Contents write out of the MVP default permission set, so Merge is not the first permission expansion.

## Source-only architecture

The merged/detached components are intentionally layered:

1. `src/integrations/github/pull-request-review-write.ts`
   - managed repositories only;
   - exactly one `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` request;
   - exact `commit_id` required;
   - fixed `REQUEST_CHANGES` event;
   - bounded non-empty body;
   - fixed GitHub REST origin, API version and media type;
   - manual redirect handling;
   - required permission contract is exactly `pull_requests:write`;
   - ambiguous transport/server/malformed-success outcomes are `WRITE_OUTCOME_UNKNOWN` and are never auto-retried.

2. `src/shared/needs-changes-decision.ts`
   - request binds request id, validated actor identity, managed repository, issue/PR numbers, expected PR head, expected default-branch head and review body;
   - an injected audit/idempotency store claims the request before live evaluation;
   - fresh authoritative GitHub reconciliation runs after the claim and immediately before the write boundary;
   - policy evidence must be complete;
   - the fresh decision must be `MERGE_READY` with CI/review PASS;
   - freshly observed PR head and default-branch head must exactly match the owner-approved values;
   - the review write is bound to the exact approved head with `commit_id`;
   - success, definitive failure and unknown outcome become terminal audit outcomes for that request id;
   - replay cannot produce a second GitHub review;
   - audit-finalization uncertainty after a possible write also fails closed against blind retry.

3. `src/integrations/github/app-installation-review-session.ts` and `src/integrations/cloudflare/d1-needs-changes-audit-store.ts`
   - future write token request is narrowed to one managed repository and exactly `pull_requests:write`;
   - returned repository/permission evidence is checked and the authorized write session is one-shot;
   - D1 stores bounded request/result evidence and exact idempotency state only;
   - production D1 migration `0002_needs_changes_audit.sql` has been separately owner-authorized and applied; that does not activate GitHub writes.

4. `src/worker/github-needs-changes-route.ts` and `src/worker/github-needs-changes-runtime.ts`
   - define an exact detached `POST /api/github/needs-changes` contract;
   - no query string is accepted;
   - JSON input has an exact bounded key set and cannot contain/override actor identity;
   - the existing cryptographic `CloudflareAccessRequestAuthenticator` supplies the only actor `{subject,email}`;
   - `canRequestChanges` is checked before the decision executor and again inside runtime composition before D1/read/token/write dependencies can run;
   - success responses omit actor identity and expose only bounded decision/review evidence;
   - unknown write/audit-finalization outcomes explicitly return `retryable:false` and remain protected by durable idempotency;
   - runtime composes the existing Phase 2 read runtime, D1 audit store and least-privilege review-write session/writer;
   - trusted Access issuer/audience are constructor inputs only in this slice; no production Wrangler variable is added.

## Project capability gate

`ManagedProjectPolicy` carries an explicit `canRequestChanges` capability.

- every currently managed repository remains `canRequestChanges: false`;
- existing Phase 2 read eligibility remains controlled by `enabled` + `githubReadEnabled` and is unchanged;
- `resolveNeedsChangesProjectPolicy()` / `requireNeedsChangesProjectPolicy()` are the action boundary;
- a repository is eligible only when it is managed/read-enabled **and** `canRequestChanges === true`;
- excluded, unknown, disabled or capability-false repositories fail closed.

Changing any project from `canRequestChanges: false` to `true` is a later reviewed activation step. It must not be bundled implicitly with route registration, GitHub App permission growth or production deployment.

## Detached means not production-reachable

Issue #221 deliberately stops before registration/activation:

- `src/worker/index.ts` does not import or register the Needs-changes handler/runtime;
- `wrangler.jsonc` does not add a Needs-changes enable flag, Access issuer/audience, GitHub write permission setting or new secret;
- all six project capabilities stay false;
- the production GitHub App remains read-only;
- no installation write token is minted by this source-only work;
- no live GitHub review is created;
- no Worker deploy occurs.

The source-boundary regression must keep these facts true until a later dedicated activation issue changes them under its own review and owner gate.

## Required activation sequence later

Live activation remains split into separately reviewed/authorized steps:

1. keep the detached Access-authenticated handler/runtime green under all-false project capabilities;
2. prepare a read-only production preflight for the exact GitHub App permission delta and Worker runtime/config delta;
3. obtain separate owner authorization before changing the dedicated GitHub App to `pull_requests: write`;
4. verify the installation accepted exactly the reviewed permission change and no broader repository permission;
5. separately review/authorize the required trusted Access runtime config and Worker route registration/deploy;
6. enable `canRequestChanges` only for an explicitly reviewed canary repository/target under its own activation boundary;
7. run one bounded canary on an explicitly selected expendable/non-production review target and exact head;
8. reconcile the resulting GitHub review and D1 audit record exactly once; never blind-retry an unknown write outcome;
9. only after canary acceptance consider UI activation/general availability.

Merge authorization remains separate from deployment and every live trust-boundary authorization.

## Validation requirements

Focused tests cover:

- exact GitHub review method/path/API version/media type/permission/event/body;
- managed-repository/input bounds and exact SHA state;
- all current managed project capabilities default false while read eligibility remains unchanged;
- excluded/unknown/capability-false repositories denied;
- exact detached HTTP method/path/query/media/body contract;
- Access authentication before action execution and actor injection rejection;
- verified Access principal mapping without identity reflection in success output;
- capability denial before D1/GitHub write dependencies;
- stale PR/default-branch state and incomplete/non-ready policy evidence;
- successful idempotent replay and conflicting/in-progress claims;
- definitive GitHub rejection, unknown write outcome and audit-finalization uncertainty;
- source boundary proving `index.ts` and Wrangler production config do not activate the new runtime.

**Production deploy: NO.**
