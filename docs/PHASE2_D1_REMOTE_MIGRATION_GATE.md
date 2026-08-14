# Phase 2 remote D1 migration gate

This document records the source-controlled safety boundary for the first production D1 schema migration. Source changes to this gate perform no Cloudflare mutation by themselves.

The controller is pinned to the reviewed production D1 identity, the exact source migration and the repository-pinned toolchain. Its default plan mode is credential-free, network-free and mutation-free. The repository runtime contract keeps Node at `>=22.12.0`, authoritative GitHub CI remains pinned to Node `22.16.0`, and Wrangler remains pinned to `4.120.0`.

## Corrected first-bootstrap prewrite contract

Cloudflare D1 maintains reserved/system schema objects. A fresh application database therefore must not be classified by the raw D1 `num_tables` value. The first-bootstrap gate instead performs SELECT-only inspection of `sqlite_schema` and treats an object as system-owned only when its `tbl_name` belongs to the documented SQLite/D1 system namespaces `sqlite_%`, `d1_%` or `_cf_%`. Any malformed schema evidence or unexpected application table, view, index or trigger fails closed.

The reviewed application objects must all be absent before first apply:

- `webhook_deliveries`;
- `idx_webhook_deliveries_repository_updated_at`;
- `idx_webhook_deliveries_state_updated_at`.

The migration-history bootstrap may be in exactly one of two states:

1. `d1_migrations` is absent; or
2. `d1_migrations` already exists as the canonical empty Wrangler `4.120.0` migration-history table.

For the second state, the gate verifies with SELECT-only evidence that:

- the only schema objects owned by `d1_migrations` are the table itself and `sqlite_autoindex_d1_migrations_1`;
- the normalized table SQL is exactly the canonical Wrangler shape:
  `CREATE TABLE "d1_migrations"( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL )`;
- the autoindex has no standalone SQL definition;
- `SELECT id, name, applied_at FROM d1_migrations ORDER BY id` returns zero rows.

Any noncanonical history schema, extra history-owned object, or non-empty migration history fails closed.

The source migration directory must still contain exactly `0001_reconciliation_core.sql` with the reviewed SHA-256. With that exact one-file source set and either an absent history table or a canonical empty history table, the initial migration is proven unapplied without asking Wrangler to mutate migration state during prewrite.

### Why prewrite does not use `wrangler d1 migrations list --remote`

Repository-pinned Wrangler `4.120.0` calls `initMigrationsTable()` before listing migrations. That can create `d1_migrations` with `CREATE TABLE IF NOT EXISTS`, so `migrations list --remote` is not a read-only prewrite operation for an uninitialized D1 database.

For this reason the controller must not run `wrangler d1 migrations list` before or after the guarded write. Before write it proves pending state from the exact one-file source set plus the migration-history bootstrap evidence above. After write it proves no-pending state by requiring `d1_migrations` to contain exactly that source migration name.

## Production reconciliation evidence

A SELECT-only reconciliation on 2026-08-14 proved the production database was in the second allowed bootstrap state:

- D1 UUID `8504e986-faf0-450c-bfb5-41b5dbf8be09`;
- database name `rozkalns-control-production`;
- jurisdiction `eu`;
- canonical `d1_migrations` table present;
- migration history empty;
- `webhook_deliveries` absent;
- both reviewed indexes absent;
- remaining schema limited to Cloudflare/SQLite system objects;
- all reconciliation SELECTs reported `changed_db=false` and `rows_written=0`.

No `APPLY_STARTED=YES` marker was emitted during the attempt that discovered this state, so no guarded migration write began.

## Central GitHub Actions execution path

The normal production path is `.github/workflows/production-d1.yml`; terminal execution on Lenovo is retained only as a reviewed fallback.

The workflow is deliberately small:

1. it listens only to newly created issue comments;
2. the job is eligible only on issue `#74`, only for the owner GitHub user ID `277435981`, only for a non-PR issue comment, and only for the reviewed authorization prefix;
3. the full comment must exactly match `authorize Phase 2 remote D1 migration rozkalns-control-production <exact-main-sha> ci <exact-ci-run-id>`;
4. the authorized SHA must equal the `issue_comment` event's default-branch `GITHUB_SHA`;
5. the job checks out `main`, installs the locked dependencies and calls the existing source-controlled D1 gate;
6. the D1 gate independently rechecks exact `main`, exact-main push CI, source/tool/migration hashes, D1 identity and the production schema prewrite state immediately before the write.

The workflow has repository permission `contents: read`, uses a GitHub-hosted Linux runner, pins external Actions to full commit SHAs, disables checkout credential persistence and serializes D1 production runs with `cancel-in-progress: false`.

The Cloudflare credential is expected only as the `production` GitHub Environment secret `CLOUDFLARE_D1_TOKEN`. It is not committed, copied to project repositories or stored in D1. The account ID and reviewed D1 identity remain source-pinned non-secret identifiers.

Merging this workflow does not itself create the Environment secret and does not execute any existing authorization comment retroactively. Live secret setup and the first Actions-based migration remain separate owner-authorized steps.

## Execution-context boundary

Apply mode now accepts exactly two reviewed execution contexts:

- local fallback: host short name `lenovo`, outside GitHub Actions;
- normal path: `issue_comment` on `refs/heads/main` in `rozkalnsandris/rozkalns-control-center`, exact authorized `GITHUB_SHA`, exact `production-d1.yml@refs/heads/main`, `RUNNER_ENVIRONMENT=github-hosted` and `RUNNER_OS=Linux`.

Any other apply context fails closed before Cloudflare credentials are used.

## One-shot write boundary

Immediately before write the controller repeats the exact repository, CI, D1 identity, application-schema absence, migration-history bootstrap and SELECT-only application-schema checks. Only after all checks pass does it emit:

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

Any authorization tied to a pre-centralization `main` SHA becomes stale after this source change merges and must not be reused. A fresh exact-main push CI and a fresh one-shot owner authorization are required for the first Actions-based apply.

Queue/DLQ, webhook activation, Worker deployment, traffic/public routing, Cloudflare Access, GitHub write permissions, RPi5 mutation and production application deployment remain outside this gate.

`Production deploy: NO`.
`Remote D1 migration: NO` from this source-only change.
