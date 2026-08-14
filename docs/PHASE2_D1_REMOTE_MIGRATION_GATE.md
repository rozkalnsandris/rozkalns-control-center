# Phase 2 remote D1 migration gate

This document records the source-controlled safety boundary for the first production D1 schema migration. The source change itself performs no Cloudflare mutation.

The controller is pinned to the reviewed production D1 identity, the exact source migration and the repository-pinned toolchain. Its default plan mode is credential-free, network-free and mutation-free. The repository runtime contract keeps the repository Node contract at `>=22.12.0`; the migration regression test explicitly enables Node 22.12's documented `--experimental-sqlite` flag, authoritative GitHub CI remains pinned to Node `22.16.0`, and Wrangler remains pinned to `4.120.0`.

## Corrected first-bootstrap prewrite contract

Cloudflare D1 maintains reserved/system schema objects. A fresh application database therefore must not be classified by the raw D1 `num_tables` value. The first-bootstrap gate instead performs SELECT-only inspection of `sqlite_schema` and treats an object as system-owned only when its `tbl_name` belongs to the SQLite/D1 system namespaces `sqlite_%`, `d1_%` or `_cf_%`. Any malformed schema evidence or unexpected application table, view, index or trigger fails closed.

For the reviewed first migration, the prewrite gate accepts exactly two migration-history bootstrap states:

1. `d1_migrations` is absent; or
2. Wrangler `4.120.0` has already created only its canonical empty migration-history table plus SQLite's unique autoindex, with zero rows in `d1_migrations`.

If `d1_migrations` exists, the gate verifies the normalized table SQL exactly as:

`CREATE TABLE "d1_migrations"( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL )`

and requires the only history-owned companion object to be `sqlite_autoindex_d1_migrations_1`. Any non-empty history, malformed/noncanonical table definition, extra history-owned object or unexpected reviewed application schema fails closed.

The application schema must still be absent before first apply:

- `webhook_deliveries`;
- `idx_webhook_deliveries_repository_updated_at`;
- `idx_webhook_deliveries_state_updated_at`.

The source migration directory must still contain exactly `0001_reconciliation_core.sql` with the reviewed SHA-256. Therefore both an entirely uninitialized database and the exact canonical empty Wrangler migration-history bootstrap state are safe first-migration inputs.

### Why prewrite does not use `wrangler d1 migrations list --remote`

Repository-pinned Wrangler `4.120.0` calls `initMigrationsTable()` before listing migrations. That creates `d1_migrations` with `CREATE TABLE IF NOT EXISTS`, so `migrations list --remote` is not a read-only prewrite operation for an uninitialized D1 database.

For this reason the controller must not run `wrangler d1 migrations list` before or after the guarded write. Before write it proves pending state from the exact one-file source set plus either absent migration history or the exact canonical empty migration-history state. After write it proves no-pending state by requiring `d1_migrations` to contain exactly that source migration name.

## One-shot write boundary

Immediately before write the controller repeats the exact repository, CI, D1 identity, migration-history bootstrap and SELECT-only application-schema checks. Only after all checks pass does it emit:

- `APPLY_STARTED=YES`;
- `AUTHORIZATION_CONSUMED=YES`;
- `NO_BLIND_RETRY_IF_STOP_AFTER_APPLY_STARTED=YES`.

The sole intended D1 schema write is then the repository-pinned equivalent of:

`wrangler d1 migrations apply rozkalns-control-production --remote`

Any failure or ambiguous result after `APPLY_STARTED=YES` requires read-only reconciliation before another authorization; never blindly retry.

## Post-verification

After a successful apply the controller uses only D1 identity GET plus SELECT-only queries to prove:

- `d1_migrations` contains exactly `0001_reconciliation_core.sql`;
- `webhook_deliveries` exists;
- both reviewed indexes exist;
- `webhook_deliveries` contains zero rows;
- the exact one-file source migration set equals the applied migration history.

A future remote migration remains separately owner-authorized after this correction is merged and a new exact-main CI succeeds. Any authorization tied to the pre-fix main SHA is stale after merge and is not reusable.

Queue/DLQ, webhook activation, Worker deployment, traffic/public routing, Cloudflare Access, GitHub write permissions, RPi5 mutation and production deployment remain outside this gate.

`Production deploy: NO`.
`Remote D1 migration: NO` until this source correction is merged and a new post-merge exact-main owner authorization is explicitly given.
