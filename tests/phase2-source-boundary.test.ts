import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("Phase 2 read contracts contain no live GitHub transport or mutation methods", async () => {
  const [provider, webhook, reconciliation, restMappers, graphqlMappers, projection] = await Promise.all([
    source("src/shared/source-control-read.ts"),
    source("src/shared/github-webhook.ts"),
    source("src/shared/github-reconciliation.ts"),
    source("src/shared/github-rest-mappers.ts"),
    source("src/shared/github-graphql-mappers.ts"),
    source("src/shared/github-projection.ts"),
  ]);

  const combined = `${provider}\n${webhook}\n${reconciliation}\n${restMappers}\n${graphqlMappers}\n${projection}`;

  assert.equal(combined.includes("api.github.com"), false);
  assert.equal(combined.includes("Authorization:"), false);
  assert.equal(combined.includes("fetch("), false);
  assert.doesNotMatch(
    combined,
    /\b(?:mergePullRequest|createPullRequest|updatePullRequest|requestChanges|rerunWorkflow|writeContents|createIssue|updateIssue)\b/,
  );
});

test("Phase 2 reconciliation model makes authoritative reread explicit", async () => {
  const [provider, reconciliation, projection] = await Promise.all([
    source("src/shared/source-control-read.ts"),
    source("src/shared/github-reconciliation.ts"),
    source("src/shared/github-projection.ts"),
  ]);

  assert.match(provider, /authoritativeRead:\s*true/);
  assert.match(provider, /getPullRequestMergeState/);
  assert.match(reconciliation, /authoritativeReadRequired:\s*true/);
  assert.match(reconciliation, /requireManagedProjectPolicy/);
  assert.match(projection, /Only authoritative source-control snapshots may be projected/);
  assert.match(projection, /allowedActions:\s*\["OPEN_PR"\]/);
});

test("Phase 2 projection fails closed when policy or authoritative merge evidence is not ready", async () => {
  const projection = await source("src/shared/github-projection.ts");

  assert.match(projection, /if \(!policy\) return "WAITING"/);
  assert.match(projection, /if \(!policy\) return "PENDING"/);
  assert.match(projection, /mergeState\.mergeable === "MERGEABLE"/);
  assert.match(projection, /mergeState\.mergeStateStatus === "CLEAN"/);
  assert.match(projection, /deployImpact:\s*context\.deployImpact \?\? "UNKNOWN"/);
});
