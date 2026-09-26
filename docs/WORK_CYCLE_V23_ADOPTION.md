# Work-cycle v2.3 adoption

This repository consumes the FAST-LANE v2.3 shared work-cycle contract accepted in `rozkalnsandris/ops-workflows` at revision `274d58f2d9d3cb86feded2751b8f9009a4501f6b` under fleet tracker `#124`.

## Adopted surfaces

- `BOOTSTRAP_MANIFEST_V1` via `.github/agent-bootstrap.json`.
- START safe auto-continuation and compact terminal-response semantics while preserving repository-local owner gates.
- `WRITE_PREFLIGHT_COMPACT_V1` through the existing `.github/github-api-access-v1.json` adapter. No duplicate write-preflight framework is created.
- `AUTO_RUN_FULL_SINGLE_ISSUE_STATE_V2` for **new explicit FULL activations only**.

## AUTO-RUN FULL compatibility

The existing repository-local FULL v2 contract already enforces one active issue at a time and uses controller issue `#499`. The v2.3 normalized-state adapter therefore applies to future explicit `AUTO-RUN FULL rozkalns-control-center #<issue>` activations without rewriting controller history or previous authorization receipts.

For new runs:

- target issue owns mutable run state;
- controller owns only the lock and active-run pointer;
- receipts are evidence, not current mutable truth;
- CI, reviews, unresolved threads and mergeability are always freshly read from GitHub;
- stale writers and transition collisions STOP;
- exact replay is idempotent.

Existing historical/legacy controller state remains immutable audit evidence. A closed historical target does not by itself grant or reactivate FULL authority.

## Local stricter rules preserved

Issue `#1` and `AGENTS.md` remain authoritative. In particular:

- FAST merge remains an explicit owner decision;
- FULL requires a fresh explicit issue-scoped activation;
- FULL merge authority never implies production LIVE authority;
- Worker deploy/promotion, D1/Queue mutation, live Control actions, GitHub/Cloudflare permission changes, secrets/credentials, and RPi5/host mutations remain separately gated;
- no retry, rollback, cleanup or alternate mutation authority is created by this adoption.

## Deployment profile

`custom` is descriptive routing metadata only. The repository has production-sensitive Cloudflare/Worker/D1/Queue paths with separate live gates and no compatible ordinary SIMPLE-DEPLOY contract to activate here. This rollout performs no production deployment or cutover.
