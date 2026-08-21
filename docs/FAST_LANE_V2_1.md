# FAST-LANE v2.1 Hybrid — Rozkalns Control Center

This repository adopts the shared FAST/STRICT delivery model while keeping issue #1 and live GitHub/Cloudflare/RPi5 trust boundaries authoritative.

## FAST

FAST includes source, UI, tests, docs and deterministic orchestration logic that does not expand permissions or execute a live production mutation. A FAST PR may combine 2-5 tightly related same-risk work items inside one current phase/subsystem, with up to two scope-preserving corrective commits after CI/review findings.

## STRICT

Separate explicit owner authorization is required for production DB writes/migrations, GitHub App permission expansion, source-write capability, Cloudflare production mutation, RPi5/root/systemd/Docker/network changes, secrets/credentials, destructive cleanup and production rollout.

## CI and evidence

Phase 1 keeps current CI/production workflows intact. The project already has explicit production preflight/reconcile workflows, so FAST-LANE must not conflate source delivery with those production gates.

Produce one Ready receipt with exact base/head, reviewed scope, CI/reviews, security/deploy classification and next gate. Refresh mutable GitHub state immediately before merge. Merge remains explicit and never authorizes deploy/DB/host mutation.
