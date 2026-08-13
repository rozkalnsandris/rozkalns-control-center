import { buildHealthPayload } from "../shared/health";
import { handleGitHubReconciliationRequest } from "./github-reconciliation-route";
import { handleGitHubWebhookRequest } from "./github-webhook-route";

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json(buildHealthPayload());
    }

    if (url.pathname === "/api/github/reconcile") {
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
