import { createCloudflareGitHubReadRuntime, type CloudflareGitHubRuntimeBindings } from "../integrations/github/cloudflare-worker-runtime.js";
import type { ControlDashboardData } from "../shared/control-model.js";
import { readLiveDashboardSnapshot } from "../shared/live-dashboard.js";

export const GITHUB_DASHBOARD_ROUTE_PATH = "/api/github/dashboard" as const;

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

export interface LiveGitHubDashboardInput {
  readonly bindings: CloudflareGitHubRuntimeBindings;
  readonly observedAt: string;
}

export interface LiveGitHubDashboardDependencies {
  readonly createRuntime?: typeof createCloudflareGitHubReadRuntime;
  readonly readDashboard?: typeof readLiveDashboardSnapshot;
}

export type LiveGitHubDashboardExecutor = (
  input: LiveGitHubDashboardInput,
) => Promise<ControlDashboardData>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function executeLiveGitHubDashboard(
  input: LiveGitHubDashboardInput,
  dependencies: LiveGitHubDashboardDependencies = {},
): Promise<ControlDashboardData> {
  const runtime = (dependencies.createRuntime ?? createCloudflareGitHubReadRuntime)({
    bindings: input.bindings,
  });
  return (dependencies.readDashboard ?? readLiveDashboardSnapshot)(runtime, input.observedAt);
}

export async function handleGitHubDashboardRequest(
  request: Request,
  bindings: CloudflareGitHubRuntimeBindings,
  observedAt: string,
  execute: LiveGitHubDashboardExecutor = executeLiveGitHubDashboard,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== GITHUB_DASHBOARD_ROUTE_PATH) return json({ error: "NOT_FOUND" }, 404);
  if (request.method !== "GET") {
    const response = json({ error: "METHOD_NOT_ALLOWED" }, 405);
    response.headers.set("Allow", "GET");
    return response;
  }
  if (url.search !== "") return json({ error: "INVALID_REQUEST" }, 400);

  try {
    const snapshot = await execute({ bindings, observedAt });
    return json(snapshot);
  } catch {
    return json({ error: "LIVE_DASHBOARD_FAILED" }, 502);
  }
}
