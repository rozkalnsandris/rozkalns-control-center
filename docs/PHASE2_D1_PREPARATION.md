# Phase 2 D1 preparation boundary

Issue #69 prepares the durable delivery claim layer without creating or mutating a Cloudflare D1 resource.

## Source state

`migrations/0001_reconciliation_core.sql` remains the source-controlled schema for webhook delivery durability. The D1 delivery-claim adapter implements the existing `DeliveryClaimStore` boundary with prepared and bound SQL only. A first insert records identity/lifecycle metadata; a delivery-ID conflict is treated as a duplicate only after the stored repository/project/event identity is proven to match.

Webhook payload bodies, GitHub credentials, tokens, private keys and secrets are not persisted.

## Local verification

`tests/d1-migration-local.test.ts` executes the migration against an in-memory SQLite database and checks the durable table, both indexes and the lifecycle constraints. `wrangler.d1-local-verify.jsonc` is a local-verification-only binding shape with a synthetic UUID; it is not a deployable production resource identity.

The production `wrangler.jsonc` intentionally remains without `d1_databases`. Cloudflare requires a real D1 `database_id` from an existing resource before a Worker binding can be source-bound.

## Live boundary

A future live D1 step must be separately gated and owner-authorized. It must create or select the real D1 resource, capture and verify its real database ID, commit that exact ID into the reviewed production Wrangler binding, and only then separately authorize a remote migration apply.

This source change does not run `wrangler d1 create`, does not apply a remote migration, does not add a live Worker D1 binding, and does not change Worker traffic, webhook activation, Queue/DLQ resources, GitHub permissions, RPi5 state or production routing.

`Production deploy: NO`.
