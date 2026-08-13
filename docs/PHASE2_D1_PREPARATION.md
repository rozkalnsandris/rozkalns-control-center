# Phase 2 D1 preparation boundary

Phase 2 now has a verified production D1 resource identity and a reviewed source binding, while remote schema mutation remains separately gated.

## Durable source state

`migrations/0001_reconciliation_core.sql` remains the source-controlled schema for webhook delivery durability. The D1 delivery-claim adapter implements the existing `DeliveryClaimStore` boundary with prepared and bound SQL only. A first insert records identity/lifecycle metadata; a delivery-ID conflict is treated as a duplicate only after the stored repository/project/event identity is proven to match.

Webhook payload bodies, GitHub credentials, tokens, private keys and secrets are not persisted.

## Local verification

`tests/d1-migration-local.test.ts` executes the migration against an in-memory SQLite database and checks the durable table, both indexes and the lifecycle constraints. `wrangler.d1-local-verify.jsonc` remains a local-verification-only binding shape with a synthetic UUID; it is not a deployable production resource identity.

## Verified production resource

The separately owner-authorized D1 discovery/create gate completed successfully before this source change. The verified Cloudflare resource is:

- binding name: `CONTROL_DB`;
- database name: `rozkalns-control-production`;
- database ID: `8504e986-faf0-450c-bfb5-41b5dbf8be09`;
- jurisdiction: `eu`.

The production `wrangler.jsonc` pins that exact database name and ID and declares `migrations_dir: "migrations"`. Cloudflare documents `binding`, `database_name`, and `database_id` as the Worker D1 binding identity; `migrations_dir` selects the source-controlled migration directory.

This is a **source configuration change only**. Adding the binding to `wrangler.jsonc` does not itself apply a D1 migration and does not deploy or shift Worker traffic. The current webhook route remains runtime-disabled for durable acceptance until its secret and durable acceptor are separately wired.

## Next live boundary

Remote migration apply remains a separate owner-authorized live database mutation. Before that gate, use the exact merged `main`, exact-main CI, the verified database name/ID above, and the temporary setup token under the canonical credential policy. Prefer the database name `rozkalns-control-production` as the explicit migration target so an accidental binding-name mismatch cannot redirect the operation.

A future migration gate must verify the target resource identity before write, apply only the reviewed migration set, read back migration/schema evidence after write, and STOP before Queue/DLQ creation, webhook activation, Worker version upload/deploy, traffic/public routing, Access changes, GitHub permission changes, or RPi5/production mutation.

`Production deploy: NO`.
`Remote D1 migration: NO`.
