import { continuationFail, type ContinuationActionActor, type ContinuationActionRequest, type FoundCampaign } from "../../shared/continuation-action.js";
import type { D1BatchDatabaseLike } from "./d1-continuation-current-ready-store.js";

interface Receipt { fingerprint: string; result: string; result_revision: string | null }

/** One atomic batch: unique request claim, full-state CAS, then result audit. No retries. */
export class D1ContinuationActionStore {
  constructor(private readonly db: D1BatchDatabaseLike) {}

  async assertAvailable(): Promise<void> {
    const result = await this.db.prepare("SELECT request_id FROM continuation_action_audit LIMIT 0").run();
    if (!result.success) continuationFail("PERSISTENCE_UNAVAILABLE");
  }

  async receipt(requestId: string, fingerprint: string): Promise<Receipt | null> {
    const result = await this.db.prepare("SELECT fingerprint, result, result_revision FROM continuation_action_audit WHERE request_id = ? LIMIT 1").bind(requestId).run<Receipt>();
    if (!result.success || !Array.isArray(result.results)) continuationFail("PERSISTENCE_UNAVAILABLE");
    const row = result.results[0];
    if (!row) return null;
    if (row.fingerprint !== fingerprint) continuationFail("IDEMPOTENCY_CONFLICT");
    if (row.result !== "APPLIED" || !/^[0-9a-f]{64}$/.test(row.result_revision ?? "")) continuationFail("PREVIOUS_REQUEST_NOT_APPLIED");
    return row;
  }

  async persist(request: ContinuationActionRequest, actor: ContinuationActionActor, fingerprint: string, recovery: FoundCampaign, next: FoundCampaign["campaign"], resultRevision: string): Promise<void> {
    const old = recovery.campaign;
    const clauses: string[] = [];
    const expected: unknown[] = [];
    const campaignFields: Record<string, unknown> = {
      campaign_id: old.campaignId, schema_version: old.schemaVersion, project_id: old.projectId, repository: old.repository,
      scope: old.scope, mode: old.mode, continue_enabled: Number(old.continueEnabled), paused: Number(old.paused),
      expected_main_sha: old.expectedMainSha, current_task_id: old.currentTask?.taskId ?? null,
      current_task_state: old.currentTask?.state ?? null, next_task_id: old.nextTaskId, human_gate: old.humanGate,
      observed_at: old.observedAt, updated_at: old.updatedAt,
    };
    for (const [key, value] of Object.entries(campaignFields)) { clauses.push(`${key} IS ?`); expected.push(value); }
    clauses.push("(SELECT COUNT(*) FROM continuation_tasks WHERE campaign_id = ?) = ?");
    expected.push(old.campaignId, recovery.tasks.length);
    // One JSON binding keeps the existing 100-task contract within D1's
    // 100-bound-parameter limit, while comparing every task field atomically.
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM json_each(?) AS expected_task
      WHERE NOT EXISTS (
        SELECT 1 FROM continuation_tasks AS t WHERE t.campaign_id = ?
          AND t.task_id IS json_extract(expected_task.value, '$.taskId')
          AND t.project_id IS json_extract(expected_task.value, '$.projectId')
          AND t.repository IS json_extract(expected_task.value, '$.repository')
          AND t.issue_number IS json_extract(expected_task.value, '$.issueNumber')
          AND t.task_state IS json_extract(expected_task.value, '$.taskState')
          AND t.active_pull_request_number IS json_extract(expected_task.value, '$.activePullRequestNumber')
          AND t.expected_head_sha IS json_extract(expected_task.value, '$.expectedHeadSha')
          AND t.priority IS json_extract(expected_task.value, '$.priority')
          AND t.updated_at IS json_extract(expected_task.value, '$.updatedAt')
      )
    )`);
    expected.push(JSON.stringify(recovery.tasks), old.campaignId);
    const results = await this.db.batch([
      this.db.prepare("INSERT INTO continuation_action_audit (request_id, fingerprint, campaign_id, repository, action, actor_subject, actor_email, expected_main_sha, expected_revision, requested_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CLAIMED')")
        .bind(request.requestId, fingerprint, old.campaignId, old.repository, request.action, actor.subject, actor.email, request.expectedMainSha, request.revision, next.updatedAt),
      this.db.prepare(`UPDATE continuation_campaigns SET continue_enabled = ?, paused = ?, next_task_id = ?, observed_at = ?, updated_at = ? WHERE ${clauses.join(" AND ")}`)
        .bind(Number(next.continueEnabled), Number(next.paused), next.nextTaskId, next.observedAt, next.updatedAt, ...expected),
      this.db.prepare("UPDATE continuation_action_audit SET result = CASE WHEN changes() = 1 THEN 'APPLIED' ELSE 'CONFLICT' END, result_revision = CASE WHEN changes() = 1 THEN ? ELSE NULL END WHERE request_id = ? AND fingerprint = ? AND result = 'CLAIMED'")
        .bind(resultRevision, request.requestId, fingerprint),
    ]);
    if (results.length !== 3 || results.some((result) => !result.success) || results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) continuationFail("PERSISTENCE_CONFLICT");
    await this.receipt(request.requestId, fingerprint);
  }
}
