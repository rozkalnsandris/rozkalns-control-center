import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("Phase 2 shared/domain read contracts contain no GitHub HTTP transport or mutation methods", async () => {
  const [
    provider,
    webhook,
    reconciliation,
    restMappers,
    graphqlMappers,
    projection,
    evidenceSelection,
    policyEvidence,
    classicProtection,
    reconciliationQueue,
    reconciliationDurability,
    appAuthContract,
  ] = await Promise.all([
    source("src/shared/source-control-read.ts"),
    source("src/shared/github-webhook.ts"),
    source("src/shared/github-reconciliation.ts"),
    source("src/shared/github-rest-mappers.ts"),
    source("src/shared/github-graphql-mappers.ts"),
    source("src/shared/github-projection.ts"),
    source("src/shared/github-evidence-selection.ts"),
    source("src/shared/github-policy-evidence.ts"),
    source("src/shared/github-classic-protection-mapper.ts"),
    source("src/shared/reconciliation-queue.ts"),
    source("src/shared/reconciliation-durability.ts"),
    source("src/integrations/github/app-installation-read-contract.ts"),
  ]);

  const combined = `${provider}\n${webhook}\n${reconciliation}\n${restMappers}\n${graphqlMappers}\n${projection}\n${evidenceSelection}\n${policyEvidence}\n${classicProtection}\n${reconciliationQueue}\n${reconciliationDurability}\n${appAuthContract}`;

  assert.equal(combined.includes("api.github.com"), false);
  assert.equal(combined.includes("Authorization:"), false);
  assert.equal(combined.includes("fetch("), false);
  assert.doesNotMatch(
    combined,
    /\b(?:mergePullRequest|createPullRequest|updatePullRequest|requestChanges|rerunWorkflow|writeContents|createIssue|updateIssue)\b/,
  );
});

test("dedicated GitHub integration transport owns the Phase 2 REST network boundary", async () => {
  const [transport, worker] = await Promise.all([
    source("src/integrations/github/rest-read-transport.ts"),
    source("src/worker/index.ts"),
  ]);

  assert.match(transport, /GITHUB_REST_ORIGIN = "https:\/\/api\.github\.com"/);
  assert.match(transport, /GITHUB_REST_ACCEPT = "application\/vnd\.github\+json"/);
  assert.match(transport, /method: "GET"/);
  assert.match(transport, /redirect: "manual"/);
  assert.match(transport, /GITHUB_REST_API_VERSION/);
  assert.match(transport, /PAGINATION_BUDGET_EXHAUSTED/);
  assert.match(transport, /RATE_LIMITED/);
  assert.doesNotMatch(transport, /\b(?:POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(transport, /Authorization|Bearer|ghs_/);
  assert.doesNotMatch(worker, /rest-read-transport|api\.github\.com/);
});

test("dedicated GitHub App session owns JWT, token exchange and Authorization primitives", async () => {
  const [session, worker, wrangler] = await Promise.all([
    source("src/integrations/github/app-installation-session.ts"),
    source("src/worker/index.ts"),
    source("wrangler.jsonc"),
  ]);

  assert.match(session, /GITHUB_APP_JWT_ALGORITHM = "RS256"/);
  assert.match(session, /GITHUB_APP_JWT_CLOCK_SKEW_SECONDS = 60/);
  assert.match(session, /GITHUB_APP_JWT_FUTURE_LIFETIME_SECONDS = 9 \* 60/);
  assert.match(session, /\/app\/installations\/\$\{installationId\}\/access_tokens/);
  assert.match(session, /method: "POST"/);
  assert.match(session, /Authorization: `Bearer \$\{appJwt\}`/);
  assert.match(session, /Authorization: `Bearer \$\{rawCredential\}`/);
  assert.match(session, /repositories: scope\.repositories\.map\(repositoryName\)/);
  assert.match(session, /permissions: \{ \.\.\.scope\.permissions \}/);
  assert.doesNotMatch(session, /ghs_/);
  assert.doesNotMatch(session, /token\.startsWith|token\.length/);
  assert.doesNotMatch(session, /BEGIN (?:RSA )?PRIVATE KEY/);
  assert.doesNotMatch(worker, /app-installation-session|Authorization|Bearer|api\.github\.com/);
  assert.doesNotMatch(wrangler, /"secrets"|"vars"/);
});

test("Phase 2 reconciliation model makes authoritative reread and exact-head status evidence explicit", async () => {
  const [provider, reconciliation, projection, evidenceSelection] = await Promise.all([
    source("src/shared/source-control-read.ts"),
    source("src/shared/github-reconciliation.ts"),
    source("src/shared/github-projection.ts"),
    source("src/shared/github-evidence-selection.ts"),
  ]);

  assert.match(provider, /authoritativeRead:\s*true/);
  assert.match(provider, /getPullRequestMergeState/);
  assert.match(provider, /listCommitStatuses/);
  assert.match(provider, /Commit-status evidence does not match/);
  assert.match(reconciliation, /authoritativeReadRequired:\s*true/);
  assert.match(reconciliation, /requireManagedProjectPolicy\(webhook\.repository\)/);
  assert.doesNotMatch(reconciliation, /repositoryHint/);
  assert.match(projection, /Only authoritative source-control snapshots may be projected/);
  assert.match(projection, /selectLatestEffectiveCheckRuns/);
  assert.match(projection, /selectLatestEffectiveWorkflowRuns/);
  assert.match(projection, /allowedActions:\s*\["OPEN_PR"\]/);
  assert.match(evidenceSelection, /maximalByProvableOrder/);
  assert.match(evidenceSelection, /workflowId == null/);
});

test("verified webhook boundary owns repository identity after HMAC verification", async () => {
  const webhook = await source("src/shared/github-webhook.ts");

  assert.match(webhook, /repositoryFromVerifiedPayload/);
  assert.match(webhook, /repository:\s*repositoryFromVerifiedPayload\(payload\)/);
  assert.match(webhook, /GitHub webhook signature verification failed/);
});

test("Phase 2 projection fails closed when policy or authoritative merge evidence is not ready", async () => {
  const projection = await source("src/shared/github-projection.ts");

  assert.match(projection, /if \(!policy\) return "WAITING"/);
  assert.match(projection, /if \(!policy\) return "PENDING"/);
  assert.match(projection, /mergeState\.mergeable === "MERGEABLE"/);
  assert.match(projection, /mergeState\.mergeStateStatus === "CLEAN"/);
  assert.match(projection, /passingCheckConclusions = new Set\(\["success", "neutral", "skipped"\]\)/);
  assert.match(projection, /item\.appId === required\.integrationId/);
  assert.match(projection, /deployImpact:\s*context\.deployImpact \?\? "UNKNOWN"/);
});

test("Phase 2 branch-policy evidence cannot fabricate complete policy from one GitHub source", async () => {
  const policyEvidence = await source("src/shared/github-policy-evidence.ts");

  assert.match(policyEvidence, /GITHUB_ACTIVE_RULES/);
  assert.match(policyEvidence, /GITHUB_CLASSIC_BRANCH_PROTECTION/);
  assert.match(policyEvidence, /BRANCH_POLICY_COVERAGE_INCOMPLETE/);
  assert.match(policyEvidence, /REQUIRED_CHECK_SOURCE_IDENTITY_UNKNOWN/);
  assert.match(policyEvidence, /integrationId:\s*check\.integrationId/);
  assert.match(policyEvidence, /CODE_OWNER_REVIEW_NOT_MODELED/);
});

test("classic protection mapper is pure source mapping and keeps producer identity explicit", async () => {
  const classicProtection = await source("src/shared/github-classic-protection-mapper.ts");

  assert.match(classicProtection, /GITHUB_CLASSIC_BRANCH_PROTECTION/);
  assert.match(classicProtection, /app_id/);
  assert.match(classicProtection, /sourceIdentityKnown/);
  assert.match(classicProtection, /required_conversation_resolution/);
  assert.equal(classicProtection.includes("Administration:"), false);
});

test("durability contracts add no live D1 or Queue binding or network side effect", async () => {
  const [queueContract, durabilityContract, wrangler, migration] = await Promise.all([
    source("src/shared/reconciliation-queue.ts"),
    source("src/shared/reconciliation-durability.ts"),
    source("wrangler.jsonc"),
    source("migrations/0001_reconciliation_core.sql"),
  ]);

  const sourceContracts = `${queueContract}\n${durabilityContract}`;
  assert.equal(sourceContracts.includes("fetch("), false);
  assert.equal(sourceContracts.includes("D1Database"), false);
  assert.doesNotMatch(sourceContracts, /\bQueue\s*</);
  assert.doesNotMatch(sourceContracts, /\benv\./);

  assert.doesNotMatch(wrangler, /"d1_databases"/);
  assert.doesNotMatch(wrangler, /"queues"/);
  assert.match(migration, /delivery_id TEXT PRIMARY KEY NOT NULL/);
  assert.doesNotMatch(migration, /^\s*(?:token|secret|private_key|webhook_payload|payload_body)\s+/im);
});

test("GitHub App read contract keeps credentials opaque and transport source-only", async () => {
  const contract = await source("src/integrations/github/app-installation-read-contract.ts");

  assert.match(contract, /GITHUB_REST_API_VERSION = "2026-03-10"/);
  assert.match(contract, /GitHubInstallationReadTransport/);
  assert.match(contract, /get<T>/);
  assert.match(contract, /pages:\s*readonly T\[\]/);
  assert.doesNotMatch(contract, /\b(?:post|put|patch|delete)<T>/i);
  assert.doesNotMatch(contract, /ghs_/);
  assert.doesNotMatch(contract, /token\.length|token\.startsWith/);
  assert.doesNotMatch(contract, /Authorization|Bearer/);
  assert.doesNotMatch(contract, /api\.github\.com|fetch\(/);
  assert.doesNotMatch(contract, /"administration"/);
});
