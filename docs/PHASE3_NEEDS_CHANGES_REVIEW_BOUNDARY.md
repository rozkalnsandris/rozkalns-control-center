# Phase 3 — guarded `Needs changes` review boundary

Status: **source-only contract**.

This slice starts the first real Phase 3 GitHub mutation contract without activating a live mutation path or expanding the production GitHub App.

## Why `Needs changes` is first

GitHub's current REST `Create a review for a pull request` endpoint supports GitHub App installation access tokens, requires `Pull requests: write`, accepts an explicit `commit_id`, and supports `event=REQUEST_CHANGES`.

The REST merge endpoint requires `Contents: write`. Rozkalns Control explicitly keeps source Contents write out of the MVP default permission set, so Merge is not the first permission expansion.

## Source-only architecture

Two detached components are introduced:

1. `src/integrations/github/pull-request-review-write.ts`
   - managed repositories only;
   - exactly one `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` request;
   - exact `commit_id` required;
   - fixed `REQUEST_CHANGES` event;
   - bounded non-empty body;
   - fixed GitHub REST origin, API version and media type;
   - manual redirect handling;
   - required permission contract is exactly `pull_requests:write`;
   - no credential acquisition is implemented here;
   - ambiguous transport/server/malformed-success outcomes are classified as `WRITE_OUTCOME_UNKNOWN` and are never auto-retried.

2. `src/shared/needs-changes-decision.ts`
   - owner request binds request id, validated Access actor identity, managed repository, issue/PR numbers, expected PR head, expected default-branch head and review body;
   - an injected audit/idempotency store claims the request before live evaluation;
   - fresh authoritative GitHub reconciliation runs after the claim and immediately before the write boundary;
   - policy evidence must be complete;
   - the fresh decision must be `MERGE_READY` with CI/review PASS;
   - freshly observed PR head must equal the owner-approved expected head;
   - freshly observed default-branch head must equal the owner-approved expected main SHA;
   - the review write is bound to the exact approved head with `commit_id`;
   - success, definitive failure and unknown outcome become terminal audit outcomes for that request id;
   - replay returns the stored terminal result or failure without another GitHub write;
   - in-progress/conflicting/unknown outcomes fail closed;
   - if audit finalization fails after a possible write, the original claim remains in progress so a blind retry cannot duplicate the review.

## Trust boundaries

This slice deliberately does **not**:

- wire a Worker mutation route;
- activate the UI `Needs changes` button;
- add `pull_requests:write` to the production GitHub App;
- implement a write-capable installation-token session;
- add Cloudflare bindings or secrets;
- write D1/Queue production state;
- add Merge or `Contents: write`;
- deploy anything.

The current `CloudflareAccessRequestAuthenticator` remains the future human identity boundary. A later Worker-route slice must cryptographically authenticate the request and pass only the verified Access principal into this decision contract.

## Required activation sequence later

Live activation must remain separately owner-gated and split into reviewed steps:

1. implement a write-capable installation session restricted to one managed repository and exactly `pull_requests:write`;
2. implement durable D1 idempotency/audit storage for the source-only audit interface;
3. wire a dedicated mutation route behind cryptographically verified Cloudflare Access;
4. expose `Needs changes` in live UI only when fresh normalized evidence makes it eligible;
5. add the exact GitHub App permission only after the implementation exists and is reviewed;
6. perform fresh read-only production preflight;
7. obtain separate owner authorization for permission/live activation;
8. run one bounded canary with an expendable/non-production review target before general availability;
9. reconcile the resulting GitHub review and audit record; never blind-retry an unknown write outcome.

Merge authorization remains separate from deployment authorization.

## Validation requirements

Focused tests cover:

- exact method/path/API version/media type/permission/event/body;
- managed-repository and input bounds;
- stale PR head;
- stale default-branch head;
- incomplete policy evidence;
- non-ready PR state;
- successful idempotent replay;
- conflicting/in-progress claims;
- definitive GitHub rejection;
- unknown write outcome;
- audit-finalization failure after a write;
- source boundary proving Worker/UI/session permissions remain unchanged.

**Production deploy: NO.**
