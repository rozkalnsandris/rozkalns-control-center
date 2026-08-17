import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

test("Phase 3 review write session is exposed only behind the capability-off Needs changes Worker boundary", async () => {
  const [
    sessionSource,
    workerIndex,
    workerRuntime,
    dashboardRuntime,
    appSource,
    wranglerSource,
    readSessionSource,
    readContractSource,
    projectPolicySource,
  ] = await Promise.all([
    source("src/integrations/github/app-installation-review-session.ts"),
    source("src/worker/index.ts"),
    source("src/integrations/github/cloudflare-worker-runtime.ts"),
    source("src/integrations/github/cloudflare-dashboard-runtime.ts"),
    source("src/react-app/App.tsx"),
    source("wrangler.jsonc"),
    source("src/integrations/github/app-installation-session.ts"),
    source("src/integrations/github/app-installation-read-contract.ts"),
    source("src/shared/project-policy.ts"),
  ]);

  assert.match(sessionSource, /permissions:\s*\{\s*pull_requests:\s*"write"\s*\}/);
  assert.match(sessionSource, /repositories:\s*\[repositoryName\(scope\.repository\)\]/);
  assert.match(sessionSource, /redirect:\s*"manual"/);
  assert.doesNotMatch(sessionSource, /contents:\s*"write"/);
  assert.doesNotMatch(sessionSource, /issues:\s*"write"/);
  assert.doesNotMatch(sessionSource, /actions:\s*"write"/);
  assert.doesNotMatch(sessionSource, /GITHUB_APP_PRIVATE_KEY_PEM/);

  for (const runtimeSource of [workerIndex, workerRuntime, dashboardRuntime, appSource, wranglerSource]) {
    assert.doesNotMatch(runtimeSource, /app-installation-review-session/);
    assert.doesNotMatch(runtimeSource, /createGitHubAppPullRequestWriteSessionProvider/);
    assert.doesNotMatch(runtimeSource, /pull_requests\s*[:=]\s*["']write["']/);
  }

  assert.match(workerIndex, /GITHUB_NEEDS_CHANGES_ROUTE_PATH/);
  assert.match(workerIndex, /handleGitHubNeedsChangesRequest/);
  assert.doesNotMatch(appSource, /\/api\/.*needs-changes/i);
  assert.equal((projectPolicySource.match(/canRequestChanges: true/g) ?? []).length, 0);
  assert.equal((projectPolicySource.match(/canRequestChanges: false/g) ?? []).length, 6);

  assert.match(readSessionSource, /parseGitHubInstallationReadScope/);
  assert.doesNotMatch(readSessionSource, /app-installation-review-session/);
  assert.match(readContractSource, /access !== "read"/);
  assert.match(readContractSource, /must remain read-only/);
});

test("write session has no raw credential export and no fixed legacy installation-token format assumption", async () => {
  const sessionSource = await source("src/integrations/github/app-installation-review-session.ts");

  assert.doesNotMatch(sessionSource, /token\.length\s*===\s*40/);
  assert.doesNotMatch(sessionSource, /\^ghs_/);
  assert.doesNotMatch(sessionSource, /rawCredential:\s*payload\.rawCredential\s*[,}]/);
  assert.match(sessionSource, /Authorization:\s*`Bearer \$\{rawCredential\}`/);
  assert.match(sessionSource, /credentialLease:\s*lease/);
});
