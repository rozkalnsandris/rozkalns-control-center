# Phase 2 remote D1 migration gate

This document records the source-controlled safety boundary for the first production D1 schema migration. The source change itself performs no Cloudflare mutation.

The controller is pinned to the reviewed production D1 identity, the exact source migration and the repository-pinned toolchain. Its default plan mode is credential-free, network-free and mutation-free. The repository runtime contract keeps the repository Node contract at `>=22.12.0`; the migration regression test explicitly enables Node 22.12's documented `--experimental-sqlite` flag, authoritative GitHub CI remains pinned to Node `22.16.0`, and Wrangler remains pinned to `4.120.0`.

## Corrected first-bootstrap prewrite contract

Cloudflare D1 maintains reserved/system schema objects. A fresh application database therefore must not be classified by the raw D1 `num_tables` value. The first-bootstrap gate instead performs SELECT-only inspection of `sqlite_schema` and tolerates only the documented SQLite/D1 system namespaces `sqlite_%`, `d1_%` and `_cf_%`. Any malformed schema evidence or unexpected application table, view, index or trigger fails closed.

The reviewed project objects are checked separately and must all be absent before first apply:

- `d1_migrations`;
- `webhook_deliveries`;
- `idx_webhook_deliveries_repository_updated_at`;
- `idx_webhook_deliveries_state_updated_at`.

The source migration directory must still contain exactly `0001_reconciliation_core.sql` with the reviewed SHA-256. With that exact one-file source set and `d1_migrations` absent, the initial migration is necessarily unapplied without asking Wrangler to initialize migration state.

### Why prewrite does not use `wrangler d1 migrations list --remote`

Repository-pinned Wrangler `4.120.0` calls `initMigrationsTable()` before listing migrations. That creates `d1_migrations` with `CREATE TABLE IF NOT EXISTS`, so `migrations list --remote` is not a read-only prewrite operation for an uninitialized D1 database.

For this reason the controller must not run `wrangler d1 migrations list` before or after the guarded write. Before write it proves pending state from the exact one-file source set plus absence of `d1_migrations`. After write it proves no-pending state by requiring `d1_migrations` to contain exactly that source migration name.

## One-shot write boundary

Immediately before write the controller repeats the exact repository, CI, D1 identity, project-schema absence and SELECT-only application-schema checks. Only after all checks pass does it emit:

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
