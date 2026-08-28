import { URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const liveDashboard = { generatedAt: "2026-08-28T18:00:00Z", projects: [{ id: "browser-project", displayName: "Browser Test Project", repository: "rozkalnsandris/browser-test", enabled: true, productionAdapter: "none", status: "ATTENTION", openPullRequests: 1, openIssues: 1 }], decisions: [{ id: "browser-live-merge", projectId: "browser-project", workflowState: "NEEDS_ANDRIS", issueNumber: 421, issueTitle: "Browser regression fixture", prNumber: 999, prTitle: "Browser regression live decision", prUrl: "https://github.com/rozkalnsandris/rozkalns-control-center/pull/999", ci: "PASS", review: "PASS", deployImpact: "NO_DEPLOY", changedFiles: 2, expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", reason: "Fresh live evidence permits decision controls to be presented.", lastReconciledAt: "2026-08-28T17:59:30Z", allowedActions: ["MERGE", "NEEDS_CHANGES", "LATER", "OPEN_PR"] }] };
function sendJson(response, statusCode, payload) { response.statusCode = statusCode; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.end(JSON.stringify(payload)); }
function scenarioFromReferer(request) { const referer = request.headers.referer; if (!referer) return null; try { return new URL(referer).searchParams.get("browserScenario"); } catch { return null; } }
async function readJsonBody(request) { let body = ""; for await (const chunk of request) { body += chunk.toString(); if (body.length > 12000) throw new Error("browser action request too large"); } return JSON.parse(body); }

export default defineConfig({ plugins: [react(), { name: "control-browser-regression-api", configureServer(server) { let staleArmed = false; let dashboardRequests = 0; let actionRequests = [];
  server.middlewares.use((request, response, next) => { const requestUrl = request.url ?? "/";
    if (requestUrl.startsWith("/__browser/arm-stale")) { staleArmed = true; response.statusCode = 204; response.end(); return; }
    if (requestUrl.startsWith("/__browser/reset")) { staleArmed = false; dashboardRequests = 0; actionRequests = []; response.statusCode = 204; response.end(); return; }
    if (requestUrl.startsWith("/__browser/state")) { sendJson(response, 200, { dashboardRequests, actionRequests }); return; }
    if (requestUrl.startsWith("/api/health")) { sendJson(response, 200, { status: "ok", service: "rozkalns-control", phase: "phase-0", workerVersion: "browser-regression" }); return; }
    if (requestUrl.startsWith("/api/github/dashboard")) { dashboardRequests += 1; const scenario = scenarioFromReferer(request); if (scenario === "fixture") { sendJson(response, 503, { error: "LIVE_READ_DISABLED" }); return; } if (scenario === "stale" && staleArmed) { sendJson(response, 500, { error: "BROWSER_TEST_REFRESH_FAILURE" }); return; } sendJson(response, 200, liveDashboard); return; }
    if (request.method === "POST" && ["/api/github/merge", "/api/github/needs-changes", "/api/github/later"].includes(requestUrl)) { void readJsonBody(request).then((body) => { actionRequests.push({ path: requestUrl, body }); setTimeout(() => sendJson(response, 200, { ok: true }), 120); }).catch(() => sendJson(response, 400, { error: "INVALID_BROWSER_REQUEST" })); return; }
    next();
  });
} }] });
