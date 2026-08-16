# Phase 3 — Needs changes D1 activation gate

Status: source-only activation contract for `migrations/0002_needs_changes_audit.sql`.

This document does **not** authorize a production D1 write. The remote migration remains a separate owner-gated live action after merge and successful exact-main CI.

## Why this gate exists

PR #214 added the durable `needs_changes_decisions` schema and D1 adapter, but a source-controlled migration file does not change production by itself. Before any future `Needs changes` runtime can use that audit store, production D1 must receive `0002_needs_changes_audit.sql` through a narrowly reviewed one-shot path.

The historical `scripts/cloudflare-d1-migration-gate.mjs` and `.github/workflows/production-d1.yml` belong to the completed first-production-D1 canary. They stay intact as historical evidence and are not reused for Phase 3.

The Phase 3 gate is:

```text
scripts/cloudflare-needs-changes-d1-migration-gate.mjs
```

Package entry point:

```text
npm run cf:needs-changes-d1-migration-gate -- ...
```

## External platform contract checked for this design

Current Cloudflare D1 documentation says:

- migrations are tracked in the configured `d1_migrations` table;
- `wrangler d1 migrations apply <database> --remote` applies unapplied migrations in sequence;
- using the immutable database name is safer than relying on a binding name that could change;
- migration apply captures a backup;
- a failing migration is rolled back while earlier successful migrations remain applied.

The gate therefore proves the exact production history and source set itself instead of trusting a mutable CLI display as authorization evidence.

## PLAN mode

Running the gate with no arguments is non-mutating and credential-free:

```bash
npm run cf:needs-changes-d1-migration-gate
```

PLAN reports the pinned production target, reviewed migration, owner-authorization format and safety boundaries. PLAN does not contact Cloudflare or GitHub and does not read credentials.

## APPLY prerequisites

A later APPLY is allowed only when all of these are true:

1. the owner has explicitly authorized this one production D1 migration after reviewing the then-current exact `main` and exact-main CI;
2. execution is local on host `lenovo`;
3. branch is `main` and the worktree is clean;
4. local `HEAD` and fresh `origin/main` equal the authorized SHA;
5. the supplied CI run is the successful `push` CI for that exact SHA;
6. Node is at least 22.12.0 and repository Wrangler remains exactly 4.120.0;
7. `wrangler.jsonc` still binds `CONTROL_DB` to production D1 `rozkalns-control-production` / UUID `8504e986-faf0-450c-bfb5-41b5dbf8be09` with `migrations_dir=migrations`;
8. the migration directory contains exactly `0001_reconciliation_core.sql` and `0002_needs_changes_audit.sql` with the reviewed SHA-256 values;
9. `0002` remains a schema-only create-table-plus-two-index migration and does not reference `webhook_deliveries`;
10. production D1 identity is exact and EU-jurisdiction-bound;
11. `d1_migrations` has the canonical Wrangler schema and contains exactly `0001_reconciliation_core.sql`;
12. production application schema exactly matches the Phase 2 baseline, including the existing webhook table/indexes, while the `needs_changes_decisions` table/indexes are absent.

All prewrite Cloudflare verification is GET or one `SELECT`. The verifier rejects any query result that reports a database write.

## One-shot write boundary

Immediately before the external Wrangler command the gate prints:

```text
APPLY_STARTED=YES
AUTHORIZATION_CONSUMED=YES
NO_BLIND_RETRY_AFTER_APPLY_STARTED=YES
```

After that point the authorization is permanently consumed, regardless of CLI exit status.

The only remote mutation command in the gate is equivalent to:

```text
wrangler d1 migrations apply rozkalns-control-production --remote
```

with the repository config and automatic provisioning/creation disabled. The gate does not run `d1 execute`, import SQL, Worker deploy, Queue mutation, webhook replay, Access mutation or GitHub permission changes.

## Postwrite reconciliation

A successful command is accepted only if read-only verification proves:

- migration history is exactly `0001`, then `0002`;
- Phase 2 webhook schema is still present;
- `needs_changes_decisions` and its two reviewed indexes are present;
- the SQLite primary-key autoindex is present;
- the new audit table contains zero rows immediately after migration.

The gate does not require the existing `webhook_deliveries` row count to remain constant because legitimate webhook traffic can occur concurrently. `0002` is instead byte-pinned and statically constrained to avoid referencing that table.

If the Wrangler command returns nonzero after `APPLY_STARTED=YES`, the gate performs a read-only reconciliation attempt and reports one of:

- `PREWRITE_UNCHANGED`;
- `TARGET_APPLIED`;
- `OTHER_REVIEW_REQUIRED`;
- `READ_FAILED_REVIEW_REQUIRED`.

It still exits for human review. **Never rerun the same authorization.** A second mutation would require fresh read-only reconciliation, a new exact-main gate and a new explicit owner authorization.

## What applying 0002 does not authorize

Even after a successful remote migration, all of these remain separately gated:

- Worker POST route/runtime activation for `Needs changes`;
- GitHub App `pull_requests: write` permission growth in production;
- installation-token minting for a live write;
- a live `REQUEST_CHANGES` review;
- UI button activation;
- Worker deploy;
- Merge / `Contents: write` capability;
- Queue replay, webhook redelivery or unrelated D1 data mutation.

The migration only makes the durable audit/idempotency table available. It does not make the human-action path live.
