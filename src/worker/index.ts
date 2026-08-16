import {
  ControlWebhookQueueRuntimeError,
  resolveControlWebhookQueueRuntime,
  type ControlWebhookQueueRuntimeBindings,
} from "../integrations/cloudflare/control-webhook-queue-runtime";
import type { QueueMessageBatchLike } from "../integrations/cloudflare/reconciliation-queue-batch-consumer";
import { buildHealthPayload } from "../shared/health";
import { handleGitHubDashboardRequest } from "./github-dashboard-route";
import { handleGitHubReconciliationRequest } from "./github-reconciliation-route";
import {
  GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH,
  handleGitHubWebhookObservabilityRequest,
} from "./github-webhook-observability-route";
import { handleGitHubWebhookRequest } from "./github-webhook-route";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function resolveWebhookQueueRuntime(env: Env) {
  return resolveControlWebhookQueueRuntime(
    env as unknown as ControlWebhookQueueRuntimeBindings,
  );
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json(buildHealthPayload());
    }

    if (url.pathname === "/api/github/dashboard") {
      const liveReadEnabled = String(env.CONTROL_LIVE_READ_ENABLED) === "true";
      if (!liveReadEnabled) {
        return Response.json(
          { error: "LIVE_READ_DISABLED" },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }
      return handleGitHubDashboardRequest(request, env, new Date().toISOString());
    }

    if (url.pathname === "/api/github/reconcile") {
      const liveReadEnabled = String(env.CONTROL_LIVE_READ_ENABLED) === "true";
      if (!liveReadEnabled) {
        return Response.json(
          { error: "LIVE_READ_DISABLED" },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }
      return handleGitHubReconciliationRequest(request, env, new Date().toISOString());
    }

    if (url.pathname === GITHUB_WEBHOOK_OBSERVABILITY_ROUTE_PATH) {
      const resolution = resolveWebhookQueueRuntime(env);
      return handleGitHubWebhookObservabilityRequest(
        request,
        new Date().toISOString(),
        resolution.status === "READY" ? resolution.runtime.observabilityReader : null,
      );
    }

    if (url.pathname === "/api/github/webhook") {
      const resolution = resolveWebhookQueueRuntime(env);
      return handleGitHubWebhookRequest(
        request,
        new Date().toISOString(),
        resolution.status === "READY"
          ? {
              secret: resolution.runtime.webhookSecret,
              acceptor: resolution.runtime.webhookAcceptor,
            }
          : {
              secret: null,
              acceptor: null,
            },
      );
    }

    return new Response("Not Found", { status: 404 });
  },

  async queue(batch, env) {
    const resolution = resolveWebhookQueueRuntime(env);
    if (resolution.status !== "READY") {
      throw new ControlWebhookQueueRuntimeError("RUNTIME_UNAVAILABLE");
    }
    await resolution.runtime.consumeQueueBatch(batch as unknown as QueueMessageBatchLike);
  },
};

export default worker;
