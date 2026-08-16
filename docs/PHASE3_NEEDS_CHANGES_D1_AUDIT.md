# Phase 3 — durable D1 audit/idempotency store for `Needs changes`

Issue: #213

Status: **source-only / not activated**.

## Purpose

#209/#210 introduced the guarded `Needs changes` decision contract and its `NeedsChangesDecisionAuditStore` interface. #211/#212 added a detached least-privilege GitHub installation session. This slice supplies the missing durable D1 implementation without wiring a live mutation path.

The store exists to make one human decision request durable across Worker invocations and retries while preventing a repeated `REQUEST_CHANGES` review when the original outcome is already terminal or uncertain.

## Source-controlled migration

`migrations/0002_needs_changes_audit.sql` adds `needs_changes_decisions` after the existing Phase 2 migration.

Cloudflare D1 migrations remain sequential source-controlled SQL files. The existence or merge of this file does **not** apply it to remote D1; remote migration application remains a separately authorized live change.

The table persists only bounded decision/audit evidence:

- `request_id` primary key;
- SHA-256 request `fingerprint`;
- verified Cloudflare Access actor subject and optional email;
- managed repository and project identity;
- issue and pull-request numbers;
- exact expected PR head and main SHA;
- initial request timestamp;
- one lifecycle state: `IN_PROGRESS`, `SUCCEEDED`, `FAILED`, or `UNKNOWN`;
- bounded terminal result evidence when applicable.

It deliberately does **not** persist:

- review body text;
- Access JWTs;
- GitHub App JWTs or installation tokens;
- private keys;
- webhook secrets;
- other credential material.

The review body is already included in the higher-level SHA-256 fingerprint, so a request with changed text cannot silently reuse the same request id.

## Atomic claim and replay model

The D1 adapter claims a request with one bound statement:

```sql
INSERT INTO needs_changes_decisions (...)
VALUES (..., 'IN_PROGRESS')
ON CONFLICT(request_id) DO NOTHING
```

The returned D1 `meta.changes` value distinguishes a new claim from an existing request id.

For an existing request id the store reads exactly one durable row:

- different fingerprint → `CONFLICT`;
- same fingerprint + `IN_PROGRESS` → `IN_PROGRESS`;
- same fingerprint + terminal row → exact `REPLAY` outcome;
- malformed, ambiguous, or identity-inconsistent durable evidence → fail closed.

A later retry may have a newer observation/request time. That does not create a conflict because the fingerprint binds the actual human action identity, not the retry timestamp.

## Terminal transitions

`complete()` is one-way. Every terminal update is conditional on:

- exact `request_id`;
- exact `fingerprint`;
- current state exactly `IN_PROGRESS`.

Success additionally binds the original actor/repository/project/issue/PR/expected-SHA identity before writing observed head/main SHA and GitHub review evidence.

A zero-row or multi-row update is an error. The store therefore never overwrites an existing terminal audit record.

Terminal shapes are constrained in both TypeScript and SQLite:

- `SUCCEEDED` requires observed head/main SHA, observation time, review id/url, submit time, and completion time;
- `FAILED` accepts only the stable failure codes that the current guarded decision executor can durably finalize before/after a definitive rejection;
- `UNKNOWN` is exactly `WRITE_OUTCOME_UNKNOWN`;
- failure/unknown rows cannot carry success review evidence;
- `IN_PROGRESS` cannot carry terminal evidence.

If audit finalization itself becomes ambiguous after a possible GitHub write, the higher-level #210 contract already fails closed and does not perform a blind second review write.

## Validation

Focused tests cover:

- bound atomic claim SQL and exact values;
- no review body/credential persistence;
- same-fingerprint in-progress detection;
- request-id fingerprint conflict;
- exact success/failure/unknown replay reconstruction;
- corrupted durable identity and malformed rows;
- exact conditional success/failure/unknown transitions;
- repeated-terminal update rejection;
- unmanaged repository and malformed input rejection;
- sequential local SQLite application of migrations `0001` + `0002`;
- SQLite state/evidence constraints;
- source boundary proving the store is not imported by Worker runtime, dashboard runtime, UI, or Wrangler config.

## Not activated

This slice does **not**:

- apply migration `0002` to production D1;
- write production D1 data;
- add a Worker mutation route;
- compose the D1 store with the live Worker;
- activate a UI action;
- increase GitHub App permissions;
- mint a production write-capable installation token;
- create a GitHub review;
- deploy Cloudflare Worker code.

## Later activation order

After this source slice is merged, the next source-only step may compose an Access-authenticated Worker POST boundary while still keeping production permissions disabled. Before any live action, the campaign must separately:

1. verify the exact current production D1 schema and pending migration list read-only;
2. review the exact `0002` schema delta and rollback/recovery boundary;
3. obtain explicit owner authorization for remote D1 migration apply;
4. verify the remote table/index/constraint shape after apply;
5. separately review/authorize any GitHub App `Pull requests: write` permission change;
6. separately deploy a write-capable Worker runtime;
7. run one explicitly selected bounded review canary and reconcile D1 + GitHub evidence without blind retries.

Merge authorization is not D1-apply authorization and is not deployment authorization.

**Production deploy: NO.**
