import assert from "node:assert/strict";
import test from "node:test";

import type { ControlDashboardData } from "../src/shared/control-model.js";
import {
  executeLiveGitHubDashboard,
  handleGitHubDashboardRequest,
  type LiveGitHubDashboardInput,
} from "../src/worker/github-dashboard-route.js";

const OBSERVED_AT = "2026-08-14T18:10:00.000Z";
const bindings = {
  GITHUB_APP_PRIVATE_KEY_PEM: "test-only-not-used",
  GITHUB_APP_CLIENT_ID: "test-client",
  GITHUB_APP_INSTALLATION_ID: "1",
};

const snapshot: ControlDashboardData = {
  generatedAt: OBSERVED_AT,
  projects: [],
  decisions: [],
};

function request(path = "/api/github/dashboard", method = "GET") {
  return new Request(`https://control.invalid${path}`, { method });
}

test("dashboard route returns only normalized no-store JSON and passes one observation time to the executor", async () => {
  let captured: LiveGitHubDashboardInput | null = null;
  const response = await handleGitHubDashboardRequest(request(), bindings, OBSERVED_AT, async (input) => {
    captured = input;
    return snapshot;
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), snapshot);
  assert.deepEqual(captured, { bindings, observedAt: OBSERVED_AT });
});

test("dashboard route rejects queries, non-GET methods and unrelated paths before live execution", async () => {
  let calls = 0;
  const execute = async () => {
    calls += 1;
    return snapshot;
  };

  const queryResponse = await handleGitHubDashboardRequest(
    request("/api/github/dashboard?repository=other"),
    bindings,
    OBSERVED_AT,
    execute,
  );
  assert.equal(queryResponse.status, 400);
  assert.deepEqual(await queryResponse.json(), { error: "INVALID_REQUEST" });

  const postResponse = await handleGitHubDashboardRequest(
    request("/api/github/dashboard", "POST"),
    bindings,
    OBSERVED_AT,
    execute,
  );
  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get("allow"), "GET");

  const otherResponse = await handleGitHubDashboardRequest(request("/api/other"), bindings, OBSERVED_AT, execute);
  assert.equal(otherResponse.status, 404);
  assert.equal(calls, 0);
});

test("dashboard route sanitizes upstream failures", async () => {
  const response = await handleGitHubDashboardRequest(request(), bindings, OBSERVED_AT, async () => {
    throw new Error("token-should-not-leak SECRET_UPSTREAM_BODY");
  });

  assert.equal(response.status, 502);
  const body = await response.text();
  assert.equal(body.includes("token-should-not-leak"), false);
  assert.equal(body.includes("SECRET_UPSTREAM_BODY"), false);
  assert.deepEqual(JSON.parse(body), { error: "LIVE_DASHBOARD_FAILED" });
});

test("live dashboard executor delegates to the bounded Cloudflare dashboard reader", async () => {
  let readCalls = 0;

  const result = await executeLiveGitHubDashboard(
    { bindings, observedAt: OBSERVED_AT },
    {
      readDashboard: async (input) => {
        readCalls += 1;
        assert.deepEqual(input, { bindings, observedAt: OBSERVED_AT });
        return snapshot;
      },
    },
  );

  assert.equal(readCalls, 1);
  assert.deepEqual(result, snapshot);
});
