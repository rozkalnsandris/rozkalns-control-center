import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

test("Phase 3 Merge write primitive remains live-inactive while capability is source-prepared only for ops-workflows", async () => {
  const [mergeSession, mergeWriter, workerIndex, workerRuntime, appSource, policySource, wranglerSource] = await Promise.all([
    source("src/integrations/github/app-installation-merge-session.ts"),
    source("src/integrations/github/pull-request-merge-write.ts"),
    source("src/worker/index.ts"),
    source("src/integrations/github/cloudflare-worker-runtime.ts"),
    source("src/react-app/App.tsx"),
    source("src/shared/project-policy.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(mergeSession, /permissions:\s*\{\s*contents:\s*"write"\s*\}/);
  assert.match(mergeSession, /repositories:\s*\[repositoryName\(scope\.repository\)\]/);
  assert.doesNotMatch(mergeSession, /pull_requests:\s*"write"/);
  assert.doesNotMatch(mergeSession, /issues:\s*"write"/);
  assert.doesNotMatch(mergeSession, /actions:\s*"write"/);
  assert.doesNotMatch(mergeSession, /GITHUB_APP_PRIVATE_KEY_PEM/);

  assert.match(mergeWriter, /method:\s*"PUT"/);
  assert.match(mergeWriter, /merge_method:\s*normalizedMergeMethod/);
  assert.match(mergeWriter, /sha:\s*expectedHeadSha/);
  assert.match(mergeWriter, /response\.status === 409/);
  assert.doesNotMatch(mergeWriter, /retry/i);

  for (const runtimeSource of [workerIndex, workerRuntime, appSource, wranglerSource]) {
    assert.doesNotMatch(runtimeSource, /app-installation-merge-session/);
    assert.doesNotMatch(runtimeSource, /createGitHubAppMergeSessionProvider/);
    assert.doesNotMatch(runtimeSource, /pull-request-merge-write/);
    assert.doesNotMatch(runtimeSource, /\/api\/github\/merge/i);
  }

  assert.equal((policySource.match(/canMerge:\s*false/g) ?? []).length, 5);
  assert.equal((policySource.match(/canMerge:\s*true/g) ?? []).length, 1);
  assert.match(
    policySource,
    /repository: "rozkalnsandris\/ops-workflows"[^\n]+canMerge: true/,
  );
  assert.equal((policySource.match(/canRequestChanges:\s*true/g) ?? []).length, 1);
  assert.equal((policySource.match(/canRequestChanges:\s*false/g) ?? []).length, 5);
});

test("Merge installation credential remains internal and session is explicitly single-use", async () => {
  const sessionSource = await source("src/integrations/github/app-installation-merge-session.ts");

  assert.doesNotMatch(sessionSource, /token\.length\s*===\s*40/);
  assert.doesNotMatch(sessionSource, /\^ghs_/);
  assert.doesNotMatch(sessionSource, /rawCredential:\s*payload\.rawCredential\s*[,}]/);
  assert.match(sessionSource, /Authorization:\s*`Bearer \$\{rawCredential\}`/);
  assert.match(sessionSource, /let consumed = false/);
  assert.match(sessionSource, /if \(consumed\)/);
  assert.match(sessionSource, /consumed = true/);
});
