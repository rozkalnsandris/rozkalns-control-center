# Phase 4 Telegram activation pre-LIVE controller

Issue #548 adds a repository-owned, source-only controller for the decision immediately before any Telegram activation LIVE work. The controller is intentionally GET-only and runs in the existing `production-readonly-reconcile` environment. It does not authorize or perform production mutation.

## Read-only evidence contract

`.github/workflows/phase4-telegram-activation-prelive-controller.yml` is manual and main-only. A run freezes one exact `approved_sha`, requires successful push CI for that exact `main` SHA, records the single-version 100% Worker deployment baseline, inventories the active version's notification bindings, and then inventories the notification Queue independently of whether the active Worker is still dormant.

The Queue path uses only Cloudflare GET endpoints to distinguish Queue absent/present, delivery paused/active, runtime producer absent/present-expected/drifted, consumer absent/present-expected/drifted, and best-effort point-in-time backlog count/bytes/oldest-message timestamp. Missing activation bindings do not short-circuit Queue evidence. Ambiguous Queue identity, missing documented pause state, invalid metrics, SHA drift, or deployment drift fail closed.

Remote D1 migration history remains `D1_NOTIFICATION_MIGRATIONS=NOT_PROVEN_GET_ONLY`. This controller does not issue D1 queries or infer migration application from repository files.

## Frozen future LIVE envelope

The receipt binds the exact repository, SHA, Cloudflare account/Worker target, production deployment/version baseline and exact-main CI run. It also records bounded future mutation categories without granting them:

- D1: zero mutations until a separately reviewed migration-evidence path exists.
- Queue preparation: at most one Queue create, one pause/config update, and one Worker-consumer write; the receipt records which of those are actually required by the observed topology.
- Secrets: at most two named secret-binding mutations (`CONTROL_TELEGRAM_BOT_TOKEN`, `CONTROL_TELEGRAM_CHAT_ID`); values are never printed or stored.
- Worker rollout: reuse `.github/workflows/production-worker-composite-live.yml` with exactly one strict version upload, one 0%-candidate attachment deployment, GET-only exact-candidate smoke, and one 100% promotion deployment.
- Provider delivery: remains a separate boundary. The pre-LIVE controller performs zero Telegram API requests; any final Queue resume/provider-delivery activation requires separate explicit authorization after backlog evidence is reviewed.

Queue delete/purge, arbitrary D1 writes, secret export, permission changes, DNS/Access/route/binding changes, rollback, cleanup and every unlisted mutation are excluded.

## Activation order and gates

The controller does not collapse D1, Queue, secrets, Worker rollout and provider delivery into a generic deploy label. They remain separate fail-closed categories. Current source can become Ready and merge independently; a later LIVE decision must re-run this controller from the exact merged `main` SHA and separately resolve D1 migration evidence before any production mutation is authorized.
