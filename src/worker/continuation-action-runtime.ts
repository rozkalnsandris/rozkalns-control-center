import { D1ContinuationCampaignReader } from "../integrations/cloudflare/d1-continuation-campaign-reader.js";
import { D1ContinuationActionStore } from "../integrations/cloudflare/d1-continuation-action-store.js";
import type { D1BatchDatabaseLike } from "../integrations/cloudflare/d1-continuation-current-ready-store.js";
import { createCloudflareGitHubReadRuntime, type CloudflareGitHubRuntimeBindings } from "../integrations/github/cloudflare-worker-runtime.js";
import { continuationActionStates, continuationFail, continuationFingerprint, inspectContinuationAction, planContinuationAction, type ContinuationActionActor, type ContinuationActionRequest, type FoundCampaign } from "../shared/continuation-action.js";
import { disabledAction } from "../shared/decision-action-model.js";
import { requireManagedProjectPolicy } from "../shared/project-policy.js";
import { CloudflareAccessRequestAuthenticator } from "./access-request-authenticator.js";

export interface ContinuationActionBindings extends CloudflareGitHubRuntimeBindings {
  CONTROL_CONTINUATION_RUNTIME_ENABLED?: string;
  CONTROL_CONTINUATION_ACCESS_ISSUER?: string;
  CONTROL_CONTINUATION_ACCESS_AUDIENCE?: string;
  CONTROL_DB?: D1BatchDatabaseLike;
}

export function resolveContinuationActionRuntime(bindings: ContinuationActionBindings) {
  if (bindings.CONTROL_CONTINUATION_RUNTIME_ENABLED !== "true") return null;
  const db = bindings.CONTROL_DB;
  const issuer = bindings.CONTROL_CONTINUATION_ACCESS_ISSUER;
  const audience = bindings.CONTROL_CONTINUATION_ACCESS_AUDIENCE;
  if (!db || typeof db.batch !== "function" || !issuer || !audience) return null;
  try {
    const auth = new CloudflareAccessRequestAuthenticator({ issuer, audience });
    const github = createCloudflareGitHubReadRuntime({ bindings });
    const reader = new D1ContinuationCampaignReader(db);
    const store = new D1ContinuationActionStore(db);
    const now = () => new Date().toISOString();
    async function recover(repository: string, campaignId: string, expectedMainSha: string): Promise<FoundCampaign> {
      const policy = requireManagedProjectPolicy(repository);
      const result = await reader.read({ repository: policy.repository, projectId: policy.id, campaignId, expectedMainSha });
      if (result.kind !== "FOUND") continuationFail("CONTINUATION_NOT_FOUND");
      return result;
    }
    return {
      authenticator: auth,
      async preflight(repository: string, decisionId: string, expectedMainSha: string) {
        const policy = requireManagedProjectPolicy(repository);
        const prefix = `github:${policy.id}:pr:`;
        const pull = decisionId.startsWith(prefix) ? Number(decisionId.slice(prefix.length)) : NaN;
        if (!Number.isSafeInteger(pull) || pull <= 0 || decisionId !== `${prefix}${pull}`) continuationFail("INVALID_REQUEST");
        const rows = await db.prepare("SELECT c.campaign_id FROM continuation_campaigns c JOIN continuation_tasks t ON t.campaign_id = c.campaign_id AND t.task_id = c.current_task_id WHERE c.project_id = ? AND c.repository = ? AND t.active_pull_request_number = ? LIMIT 2")
          .bind(policy.id, policy.repository, pull).run<{ campaign_id: string }>();
        if (!rows.success) continuationFail("PERSISTENCE_UNAVAILABLE");
        if (rows.results.length !== 1) continuationFail("NO_UNIQUE_CONTINUATION_CAMPAIGN");
        const recovery = await recover(policy.repository, rows.results[0].campaign_id, expectedMainSha);
        const context = github.createRepositoryReadContext(policy.repository, now());
        const states = continuationActionStates(recovery);
        if (states.CONTINUE.state === "enabled") {
          const plan = await inspectContinuationAction(recovery, { provider: context.provider, now });
          if (plan.kind !== "READY" && plan.kind !== "NO_ELIGIBLE_TASK") states.CONTINUE = disabledAction(plan.kind.replaceAll("_", " ").toLowerCase());
          if (recovery.campaign.nextTaskId !== null && (plan.kind !== "READY" || plan.taskId !== recovery.campaign.nextTaskId)) states.CONTINUE = disabledAction("Next task evidence changed");
        }
        // SELECT proves the required audit table exists without creating a claim.
        await store.assertAvailable();
        return { repository: policy.repository, decisionId, observedAt: now(), continuation: { campaignId: recovery.campaign.campaignId, expectedMainSha, revision: await continuationFingerprint(recovery) }, states };
      },
      async execute(request: ContinuationActionRequest, actor: ContinuationActionActor) {
        const fingerprint = await continuationFingerprint({ request, actor });
        const receipt = await store.receipt(request.requestId, fingerprint);
        if (receipt) return { status: "ALREADY_APPLIED", action: request.action, requestId: request.requestId };
        const recovery = await recover(request.repository, request.campaignId, request.expectedMainSha);
        if (await continuationFingerprint(recovery) !== request.revision) continuationFail("AUTHORIZATION_STALE_STATE");
        const context = github.createRepositoryReadContext(recovery.campaign.repository, now());
        const proposal = await planContinuationAction(request.action, recovery, { provider: context.provider, now });
        const resultRevision = await continuationFingerprint({ ...recovery, campaign: proposal.campaign });
        // Full-state atomic CAS also covers every task and the task count.
        await store.persist(request, actor, fingerprint, recovery, proposal.campaign, resultRevision);
        return { status: "APPLIED", action: request.action, requestId: request.requestId, plan: proposal.plan.kind };
      },
    };
  } catch { return null; }
}

export type ContinuationActionRuntime = NonNullable<ReturnType<typeof resolveContinuationActionRuntime>>;
