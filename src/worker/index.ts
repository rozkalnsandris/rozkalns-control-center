import { buildHealthPayload } from "../shared/health";
import { handleGitHubReconciliationRequest } from "./github-reconciliation-route";
import { handleGitHubWebhookRequest } from "./github-webhook-route";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json(buildHealthPayload());
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

    if (url.pathname === "/api/github/webhook") {
      return handleGitHubWebhookRequest(request, new Date().toISOString(), {
        secret: null,
        acceptor: null,
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};

export default worker;
