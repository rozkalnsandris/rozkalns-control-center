# Phase 2 remote D1 migration gate

This document records the source-controlled safety boundary for the first production D1 schema migration. The source change itself performs no Cloudflare mutation.

The controller is pinned to the reviewed production D1 identity, the exact source migration and the repository-pinned toolchain. Its default plan mode is credential-free, network-free and mutation-free.

A future remote migration remains separately owner-authorized after this gate is merged and exact-main CI succeeds. Any authorization tied to an older main SHA is not reusable after this source change.

The controller fails closed on repository/CI drift, resource-identity drift, non-empty pre-migration state, unexpected migration set, unexpected schema state, or incomplete post-verification. Once a guarded write begins, the authorization is treated as consumed and an ambiguous outcome requires read-only reconciliation rather than blind retry.

Queue/DLQ, webhook activation, Worker deployment, traffic/public routing, Cloudflare Access, GitHub write permissions, RPi5 mutation and production deployment remain outside this gate.

`Production deploy: NO`.
`Remote D1 migration: NO` until a new post-merge exact-main owner authorization is explicitly given.
