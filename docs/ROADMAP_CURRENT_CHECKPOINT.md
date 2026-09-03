# Rozkalns Control — Current Roadmap Checkpoint

Last reconciled: **2026-09-03**.

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
- **Phase 2 — read-only GitHub/control-plane foundation:** live-read, GitHub App, webhook, D1 and Queue source architecture implemented; current production facts remain separately evidenced.
- **Phase 3 — authenticated human decision actions:** current active product phase. Merge, Needs changes and Later are source-wired, but each production capability and action remains independently gated.
- **Phase 4 — notifications and deterministic continuation:** substantial source implementation; notification transport and continuation activation remain gated.
- **Phase 5 — production visibility:** sanitized model and dashboard projection implemented; RPi5 adapter/runtime evidence remains gated.
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
- Backend canary success is not standing authorization for UI activation, a second action or a different target. #278 and the focused tracker remain authoritative for the next live gate.

### Notifications, continuation and production visibility

- D1 contracts exist for notification transitions, delivery intents, attempts and dispatch claims, with deterministic deep links and Queue-oriented runtime composition.
- No notification-provider transport or corresponding secret is configured by this baseline; source support must not be described as live delivery.
- Continuation planning, reservation, persistence and recovery exist, but the continuation runtime is not attached to a Worker route, Queue consumer or scheduler and remains opt-in.
- Production visibility normalizes main/production SHA, drift, deploy impact, runtime, health, rollback and blocker evidence for the dashboard.
- No live Control-to-RPi5 adapter is connected. Repository fixtures, source and GET-only workflow definitions cannot establish current host state.

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
4. **Documentation freshness:** README and this checkpoint now describe the current Worker/D1/Queue/live-read source architecture without treating it as deployment evidence.

These changes add no retry/requeue/delete UI, no permissive CORS, no new GitHub permission, no production decision invocation, no remote D1 apply and no deployment authority.

## Current gates

- Re-read #1 and #278 before selecting the next phase/live action; historical phase documents may preserve older source-only snapshots and cannot override current canonical state.
- Revalidate exact current `main`, required checks, expected head, reviews, rules and target state immediately before every state-dependent GitHub write.
- Apply of migration `0010`, Worker deployment/promotion, Queue mutation, decision-route invocation, capability activation, GitHub App grant/repository-selection change, Access/DNS/Tunnel mutation, secrets and credentials all require separately scoped authority.
- Merge never authorizes deployment, D1 writes, Queue writes, production decision POSTs or host mutation.
- RPi5 exact-SHA deploy, health and rollback authority remains outside this repository. No direct SSH/sudo/root shortcut is permitted.
- AI APIs, AI Gateway, Sandbox SDK and autonomous coding workers remain deferred to the final optional phase.

## Next safe step

Use issue #1 to identify the first incomplete phase exit criterion and issue #278 to establish current operational state. If the next step crosses a live boundary, create or resume the focused tracker, perform fresh GET-only preflight, bind the exact target/SHA/baseline and obtain the required explicit owner authorization before the first mutation.
