import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEPLOY_IMPACT,
  PATH_POLICY,
  classifyDeployImpact,
} from "./cloudflare-deploy-standardization.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (path) => readFile(resolve(ROOT, path), "utf8");

const contract = JSON.parse(
  await readText(".github/cloudflare-deploy-standardization-v1.json"),
);

function contractPathPolicy() {
  const policy = contract.deploy_impact.path_policy;
  return {
    sourceOnlyFiles: policy.source_only_files,
    sourceOnlyPrefixes: policy.source_only_prefixes,
    ordinaryPublicationFiles: policy.ordinary_publication_files,
    ordinaryPublicationPrefixes: policy.ordinary_publication_prefixes,
    strictLiveFiles: policy.strict_live_files,
    strictLivePrefixes: policy.strict_live_prefixes,
  };
}

test("machine contract fixes the Cloudflare-native runtime and source gate", () => {
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.repository, "rozkalnsandris/rozkalns-control-center");
  assert.equal(contract.platform, "cloudflare-workers");
  assert.deepEqual(contract.runtime, {
    worker_name: "rozkalns-control",
    worker_entrypoint: "src/worker/index.ts",
    static_assets_directory: "./dist/client",
    wrangler_config: "wrangler.jsonc",
    production_workflow: ".github/workflows/production-worker-composite-live.yml",
    health_path: "/api/health",
  });
  assert.equal(contract.source_gate.exact_reviewed_git_sha_required, true);
  assert.equal(contract.source_gate.exact_main_sha_required_before_live, true);
  assert.equal(contract.source_gate.build_test_evidence_required, true);
  assert.equal(contract.source_gate.wrangler_dry_run_required, true);
  assert.equal(contract.source_gate.unknown_or_stale_evidence_fails_closed, true);
});

test("classifier and machine contract use exactly the same path policy", () => {
  assert.deepEqual(contractPathPolicy(), PATH_POLICY);
  assert.deepEqual(contract.deploy_impact.classes, [
    DEPLOY_IMPACT.SOURCE_ONLY,
    DEPLOY_IMPACT.ORDINARY_PUBLICATION,
    DEPLOY_IMPACT.STRICT_LIVE,
  ]);
  assert.equal(contract.deploy_impact.empty_or_unknown_path, DEPLOY_IMPACT.STRICT_LIVE);
  assert.equal(contract.deploy_impact.merge_never_authorizes_live, true);
  assert.equal(
    contract.deploy_impact.strict_live_requires_separate_exact_owner_authorization,
    true,
  );
});

test("deploy impact classification is deterministic and fail closed", () => {
  assert.equal(classifyDeployImpact(["docs/README.md"]).impact, DEPLOY_IMPACT.SOURCE_ONLY);
  assert.equal(classifyDeployImpact(["README.md", "docs/a.md"]).impact, DEPLOY_IMPACT.SOURCE_ONLY);
  assert.equal(classifyDeployImpact(["src/worker/index.ts"]).impact, DEPLOY_IMPACT.ORDINARY_PUBLICATION);
  assert.equal(classifyDeployImpact(["public/icon.svg", "docs/a.md"]).impact, DEPLOY_IMPACT.ORDINARY_PUBLICATION);
  assert.equal(classifyDeployImpact(["package-lock.json"]).impact, DEPLOY_IMPACT.ORDINARY_PUBLICATION);
  assert.equal(classifyDeployImpact(["wrangler.jsonc"]).impact, DEPLOY_IMPACT.STRICT_LIVE);
  assert.equal(classifyDeployImpact(["migrations/0015.sql"]).impact, DEPLOY_IMPACT.STRICT_LIVE);
  assert.equal(classifyDeployImpact([".github/workflows/ci.yml"]).impact, DEPLOY_IMPACT.STRICT_LIVE);
  assert.equal(classifyDeployImpact(["src/app.tsx", "migrations/0015.sql"]).impact, DEPLOY_IMPACT.STRICT_LIVE);
  assert.equal(classifyDeployImpact(["unknown/new-boundary.txt"]).impact, DEPLOY_IMPACT.STRICT_LIVE);
  assert.equal(classifyDeployImpact([]).impact, DEPLOY_IMPACT.STRICT_LIVE);
});

test("production workflow preserves exact-SHA upload, candidate verification, and promotion", async () => {
  const workflow = await readText(".github/workflows/production-worker-composite-live.yml");
  const requiredMarkers = [
    "ref: ${{ inputs.approved_sha }}",
    "npm run check",
    "/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${APPROVED_SHA}",
    "npm exec -- wrangler versions upload",
    '"${candidate_version}@0%"',
    "Cloudflare-Workers-Version-Overrides",
    "MAIN_SHA_DRIFT_PREPROMOTION",
    '"${candidate_version}@100%"',
    "FINAL_HEALTH_VERSION_MISMATCH",
    "AUTOMATIC_RETRY=NO",
    "AUTOMATIC_ROLLBACK=NO",
    "AUTOMATIC_CLEANUP=NO",
  ];
  for (const marker of requiredMarkers) {
    assert.ok(workflow.includes(marker), `missing production workflow invariant: ${marker}`);
  }
});

test("Wrangler config keeps Worker and Static Assets architecture native", async () => {
  const wrangler = await readText("wrangler.jsonc");
  assert.ok(wrangler.includes('"main": "./src/worker/index.ts"'));
  assert.ok(wrangler.includes('"directory": "./dist/client"'));
  assert.ok(wrangler.includes('"run_worker_first": ["/api/*"]'));
  assert.ok(wrangler.includes('"d1_databases"'));
  assert.ok(wrangler.includes('"queues"'));
});

test("ordinary publication stays separate from strict live mutation classes", () => {
  const publication = contract.publication_contract;
  assert.equal(publication.owner_authorization_required, true);
  assert.equal(publication.upload_command, "wrangler versions upload");
  assert.equal(publication.upload_does_not_immediately_promote_traffic, true);
  assert.equal(publication.candidate_attachment_percent, 0);
  assert.equal(publication.exact_candidate_health_smoke_required, true);
  assert.equal(publication.prepromotion_main_sha_revalidation_required, true);
  assert.equal(publication.promotion_command, "wrangler versions deploy");
  assert.equal(publication.promotion_percent, 100);
  assert.equal(publication.post_promotion_health_required, true);
  assert.equal(publication.automatic_retry_after_first_mutation, false);
  assert.equal(publication.automatic_rollback_after_first_mutation, false);
  assert.equal(publication.automatic_cleanup_after_first_mutation, false);
  assert.equal(publication.fail_closed_after_ambiguous_mutation, true);

  assert.deepEqual(contract.strict_live_exclusions, {
    production_worker_or_static_assets_publication: true,
    d1_schema_or_data_remote_apply: true,
    queue_or_dlq_mutation: true,
    cloudflare_access_dns_tunnel_network_or_account_mutation: true,
    credential_or_secret_mutation: true,
    github_app_permission_or_repository_selection_expansion: true,
    rpi5_target_allowlist_host_docker_systemd_or_runtime_mutation: true,
  });
});
