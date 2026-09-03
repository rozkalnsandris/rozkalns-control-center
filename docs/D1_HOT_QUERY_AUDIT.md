# D1 hot-query audit

This source-only audit covers the operational readers present through migration `0009`. It uses local Node SQLite, whose query planner is compatible with D1's SQLite engine. No remote D1 command or mutation is part of the audit.

## Inventory and planner result

| Area | Repeated read shape | Existing planner path | Change |
| --- | --- | --- | --- |
| Reconciliation | `webhook_deliveries WHERE delivery_id = ?` | primary-key search | none |
| Observability counts | group all `webhook_deliveries` by `state` | covering scan of `idx_webhook_deliveries_state_updated_at` | none; every state must be counted |
| Observability diagnostics | non-success deliveries ordered by `updated_at, delivery_id`, bounded to 51 | full table scan plus temporary sort | add one partial ordered index |
| Notifications | transition, intent and dispatch lookups by their primary IDs; attempt history by `(delivery_id, attempt_number)` | primary/composite-primary-key searches | none |
| Continuation | campaign identity lookup and campaign task list ordered by priority/issue | existing unique campaign index and `idx_continuation_tasks_campaign_priority_issue` | none |
| Decision audit | Needs-changes, Merge and Later idempotency reads by request/decision primary ID | primary-key searches | none |

Migration `0010_webhook_observability_hot_index.sql` contains the only planner-proven addition. The diagnostic plan changes from `SCAN webhook_deliveries` plus `USE TEMP B-TREE FOR ORDER BY` to `SCAN webhook_deliveries USING INDEX idx_webhook_deliveries_active_updated_delivery`. Scanning this smaller partial index is the SQLite equivalent appropriate for an ordered bounded query: it avoids both the full table scan and temporary sort.

The index deliberately contains only non-success rows. That bounds storage and avoids maintaining index entries for the common terminal-success population. Active deliveries still incur one index update when their `updated_at` changes and one removal when they become successful; that write amplification is accepted for the dashboard's repeated bounded diagnostic read. No other index was added because existing primary, unique or ordered indexes already serve the audited lookups, or because a complete aggregate necessarily visits all state entries.

Official basis: https://developers.cloudflare.com/d1/best-practices/use-indexes/
