# Rozkalns Control — Current Roadmap Checkpoint

Last reconciled: **2026-09-08**.

Master issue #1 remains the canonical product/architecture contract, and `docs/ROADMAP.md` remains the long-form roadmap. Issue #278 is the canonical operational handoff for changing current phase or live state. This checkpoint records durable current architecture and gates; it deliberately omits transient CI runs, deployment identifiers and authorization receipts.

## Evidence boundary

- `main` source, tests and configuration prove the intended repository baseline only.
- They do **not** independently prove the active Worker version, traffic allocation, applied D1 migrations, Queue state, secret values, GitHub App grants, Cloudflare Access/routes, project capability activation or RPi5 runtime state.
- Historical live canaries prove only their bounded completed actions. Their authority is consumed and does not become standing permission.
- Any future live mutation requires fresh canonical state, GET-only preflight, an exact target/SHA/baseline, and the authority required by #1, #278 and the focused tracker.
- A source-controlled migration or `wrangler.jsonc` change is a deploy input, not an apply/deploy authorization.

## Current phase classification

- **Phase 0 — repository/contracts:** complete.
- **Phase 1 — mobile-first decision UI:** complete.
- **Phase 2 — read-only GitHub/control-plane foundation:** live-read, GitHub App, webhook, D1 and Queue architecture established; current production facts remain separately evidenced.
- **Phase 3 — authenticated human decision actions:** complete for the bounded Merge, Needs changes and Later capability/canary chain recorded by canonical #278. Completed canaries create no standing mutation authority, and project capabilities remain independently fail-closed.
- **Phase 4 — notifications and deterministic continuation:** complete for the bounded Telegram transport/continuation gate chain recorded by canonical #278. Historical Gate A/Gate B/Later receipts are terminal evidence only and must never be replayed; no completed canary creates standing Queue, notification or decision authority.
- **Phase 5 — production visibility:** active. The Control strict sanitized evidence consumer and RPi5 producer sanitization/provenance source contract are merged/source-ready. The authenticated one-way RPi5 -> Control observation delivery boundary is the current source lane; public-key provisioning, replay persistence, runtime wiring and live production evidence remain pending and separately gated.
- **Optional AI/runtime phase:** deferred.

## Durable current architecture

### Worker and browser surface

- A React/Vite mobile-first SPA is served through Cloudflare Workers Static Assets, with `/api/*` routed through the Worker first.
- Static assets and Worker-generated API responses share a compatibility-tested security policy: CSP, content-type protection, referrer policy, frame protection and minimal permissions policy. Sensitive/live API responses remain `Cache-Control: no-store`.
- One reusable read-only client contract serves health, dashboard and webhook-delivery reads with a bounded timeout and distinct timeout, navigation-abort, network/server and invalid-payload outcomes.
- The last successful snapshot can remain visible during failure, but explicit age and clock-skew checks remove fresh authority. Invalid, future or over-age evidence disables mutation-capable UI.

### GitHub authoritative reads

- The Worker source registers health, dashboard, reconciliation, Needs changes preflight and webhook-delivery observability GET routes.
- The GitHub App read runtime keeps JWTs, installation tokens and private keys inside the credential layer, narrows installation sessions to the selected repository/permissions, and exposes normalized evidence only.
- Bounded REST pagination, redirect/origin controls, fixed GraphQL merge-state reads and repository-scope validation preserve exact-head evidence and fail closed on ambiguity.
- Read-only reconciliation may use bounded conditional GETs. Validators and cached bodies are bound to installation identity, repository selection, permissions, repository, endpoint and query; `304 Not Modified` is explicit and page-local.
- State-dependent Merge, Needs changes and decision preflights do not use cached authority. They perform unconditional fresh GitHub reads.
- Sanitized rate-limit headers become `HEALTHY`, `ATTENTION`, `EXHAUSTED` or `UNKNOWN` operator evidence. Missing/malformed evidence is never inferred healthy, and requests do not auto-sleep or auto-retry.

### Webhook, Queue and D1 reconciliation

- The webhook route authenticates raw bytes before trusting payload identity, claims the delivery ID in D1 and enqueues a bounded identity-only message.
- The reconciliation Queue consumer treats messages as at-least-once triggers, performs an authoritative GitHub reread and advances a durable D1 lifecycle.
- The DLQ consumer persists bounded terminal evidence. Unknown or contradictory delivery state fails closed rather than being silently acknowledged.
- The dashboard's compact system-health view reads only sanitized, bounded webhook-delivery counts/diagnostics and provides no requeue, retry, delete or cleanup control.
- Migrations cover reconciliation, Needs changes/Merge audit and idempotency, notification state, continuation campaigns and Later deferrals.
- Migration `0010_webhook_observability_hot_index.sql` contains the single new planner-proven partial index for active delivery diagnostics. Issue #529 did not apply it to remote D1.
- The operational query inventory and local D1-compatible planner evidence live in `docs/D1_HOT_QUERY_AUDIT.md`; existing primary/unique indexes remain preferred where their plans are already bounded.

### Human decision actions

- Access-authenticated Worker routes exist for Needs changes, Merge and Later.
- Project capability checks occur before protected persistence or GitHub writes.
- Merge and Needs changes bind the actor and expected head, re-read current GitHub state, and write bounded D1 audit/idempotency evidence.
- Later recomputes a deterministic material-state fingerprint before a compare-and-swap deferral write.
- The UI requires explicit confirmation and sends exact decision evidence. Stale/invalid dashboard state cannot authorize an action.
- Canonical #278 records the bounded Phase 3 canary chain as complete. Those completed actions are historical evidence only; they do not authorize another action, another target or capability expansion.

### Notifications, continuation and production visibility

- D1 contracts exist for notification transitions, delivery intents, attempts and dispatch claims, with deterministic deep links and Queue-oriented runtime composition.
- Telegram notification transport is implemented in source/configuration, and canonical #278 records the bounded Phase 4 Gate B delivery/resume chain as completed. Repository source alone does not prove the current provider secret, Queue backlog or live delivery state.
- Continuation planning, reservation, persistence and recovery exist, and Phase 4 completion does not imply blanket autonomous continuation or a reusable authorization. Any future continuation action remains bound to its explicit deterministic state and current gate.
- Phase 5 production visibility normalizes main/production SHA, drift, deploy impact, runtime, health, rollback and blocker evidence for the dashboard.
- The merged Control consumer accepts only an exact, fail-closed allowlist of already-sanitized RPi5 evidence and rejects extra object keys/fields before the existing project/SHA/freshness/state validation.
- The canonical `RPi5_main` repository contains the equivalent-or-tighter strict producer allowlist/sanitization/provenance source contract. It acquires no production evidence and grants no host/runtime authority.
- Issue #576 defines the Control outer authenticated-delivery source boundary without changing the ten-field payload: delivery metadata remains separate, Ed25519 verification binds domain/version/delivery ID/send time/key ID and exact raw payload bytes, and Control is verifier-only.
- Signature verification returns a bounded replay identity and expiry but does not itself prove uniqueness. A later separately reviewed durable replay claim is required before trusting a delivery; this source lane adds no replay-store binding or production write.
- No live RPi5 producer/transport is connected by this checkpoint. Control must not synthesize production evidence or obtain it through SSH, sudo, generic helpers, protected host inspection, arbitrary filesystem/runtime reads or host credentials.

### Operational observability

- Worker request and Queue entrypoints emit structured events with fixed route, method, status/outcome, duration, Worker-version and safe correlation fields.
- Logs omit query values, bodies, Access cookies/JWTs, Authorization headers, GitHub credentials, webhook secrets/signatures and protected configuration; protected failures use stable codes.
- Source configuration explicitly samples persisted logs at `0.10` and traces at `0.05`, with invocation logs disabled. The pinned Wrangler schema does not support query-redaction configuration, so source-level query omission is enforced and tested.
- GitHub rate-limit health and webhook lifecycle health are read-only operator evidence. Neither creates automatic retry/requeue behavior.

## Issue #529 hardening baseline

The non-button hardening work added durable contracts in four areas:

1. **Browser/read safety:** centralized static/API security headers, fail-closed dashboard freshness and one bounded client-read timeout/offline fallback policy.
2. **Operational observability:** mobile webhook/reconciliation health, sanitized structured Worker/Queue logs and explicit cost-bounded log/trace sampling.
3. **Data/API efficiency:** a planner-evidenced D1 hot-query audit and partial index, identity-bound conditional GitHub reads, and normalized rate-limit health.
4. **Documentation freshness:** README and this checkpoint describe the Worker/D1/Queue/live-read architecture without treating repository source as current deployment evidence.

These changes add no retry/requeue/delete UI, no permissive CORS, no new GitHub permission, no production decision invocation, no remote D1 apply and no deployment authority.

## Current gates

- Canonical #278 is authoritative for the mutable Phase 5 operational gate. Do not use historical phase issue bodies or old RPi5 SHA/PR snapshots as current authority.
- The current Control work item is `PHASE5_READ_ONLY_OBSERVATION_TRANSPORT_BOUNDARY` in issue #576: define/review the one-way authenticated delivery source boundary and stop at Ready for explicit MERGE.
- Issue #576 may add source primitives, fail-closed tests and documentation only. It must not add Worker route/binding wiring, public/private key provisioning, replay-store persistence, live evidence acquisition or RPi5 host/runtime/network mutation.
- After issue #576 merges, fresh canonical #278 and current RPi5 continuity must determine the exact next bounded public-key/replay/runtime observation lane. Source readiness must not be treated as LIVE authority.
- Revalidate exact current `main`, required checks, expected head, reviews, rules and target state immediately before every state-dependent GitHub write.
- Apply of migration `0010`, Worker deployment/promotion, Queue mutation, decision-route invocation, capability activation, GitHub App grant/repository-selection change, Access/DNS/Tunnel mutation, secrets and credentials all require separately scoped authority.
- Merge never authorizes deployment, D1 writes, Queue writes, production decision POSTs or host mutation.
- RPi5 exact-SHA deploy, health and rollback authority remains outside this repository. No direct SSH/sudo/root shortcut is permitted.
- AI APIs, AI Gateway, Sandbox SDK and autonomous coding workers remain deferred to the final optional phase.

## Next safe step

Complete issue #576 through focused source/test/documentation validation, Draft PR, exact-head CI/review and Ready, then stop for explicit MERGE. No GET-only production preflight is required for this source-only gate. After merge, re-read canonical #278 and current RPi5 continuity before selecting any key provisioning, durable replay, runtime transport or production observation step; repository source still does not prove protected-host/runtime/live production state.
