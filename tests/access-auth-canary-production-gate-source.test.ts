import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const gate = readFileSync(resolve(process.cwd(), "scripts/cloudflare-access-auth-canary-gate.mjs"), "utf8");
const wrangler = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const docs = readFileSync(resolve(process.cwd(), "docs/PHASE3_ACCESS_JWT_AUTH.md"), "utf8");

test("Access auth canary production gate keeps PLAN mutation-free and owner-gated", () => {
  assert.match(gate, /ACCESS_AUTH_CANARY_GATE=PLAN_PASS/);
  assert.match(gate, /CLOUDFLARE_MUTATION=NO/);
  assert.match(gate, /WORKER_DEPLOY=NOT_EXECUTED_IN_PLAN/);
  assert.match(gate, /OWNER_AUTHORIZATION=/);
  assert.match(gate, /CONTROL_OWNER_AUTHORIZATION/);
  assert.match(gate, /NO_BLIND_RETRY_AFTER_DEPLOY_STARTED=YES/);
  assert.doesNotMatch(gate, /\bcfWrite\b/);
});

test("gate cryptographically binds the discovered issuer to the exact parent Access AUD", () => {
  assert.match(gate, /createPublicKey/);
  assert.match(gate, /verify\("RSA-SHA256"/);
  assert.match(gate, /\/cdn-cgi\/access\/certs/);
  assert.match(gate, /Access token AUD does not match the exact parent Access application/);
  assert.match(gate, /\.cloudflareaccess\.com/);
  assert.match(gate, /ACCESS_TOKEN_SIGNATURE=VERIFIED_RS256_JWKS/);
});

test("APPLY parent discovery uses the reviewed exact and wildcard host coverage helper", () => {
  assert.match(gate, /accessApplicationProtectsHost/);
  assert.match(gate, /accessApplicationProtectsHost\(app, HOSTNAME\)/);
  assert.doesNotMatch(gate, /accessApplicationPublicUris\(app\)\.includes\(HOSTNAME\)/);
});

test("APPLY is limited to one strict Worker deploy with reviewed runtime vars", () => {
  assert.match(gate, /\["deploy", "--strict", "--yes"\]/);
  for (const binding of [
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "CONTROL_LIVE_READ_ENABLED",
    "CONTROL_WEBHOOK_RUNTIME_ENABLED",
    "CONTROL_ACCESS_AUTH_CANARY_ENABLED",
    "CONTROL_ACCESS_ISSUER",
    "CONTROL_ACCESS_AUDIENCE",
  ]) {
    assert.match(gate, new RegExp(binding));
  }
  assert.match(gate, /DEPLOY_STARTED=YES/);
  assert.match(gate, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(gate, /ACCESS_AUTH_CANARY=AUTHENTICATED/);
  assert.match(gate, /MISSING_ACCESS_SUCCESS=REJECTED/);
  assert.match(gate, /FORGED_ACCESS_SUCCESS=REJECTED/);
  assert.doesNotMatch(gate, /--var[^\n]*CONTROL_ACCESS_TOKEN/);
  assert.doesNotMatch(gate, /--var[^\n]*CLOUDFLARE_API_TOKEN/);
});

test("source configuration remains free of live Access canary values", () => {
  for (const binding of [
    "CONTROL_ACCESS_AUTH_CANARY_ENABLED",
    "CONTROL_ACCESS_ISSUER",
    "CONTROL_ACCESS_AUDIENCE",
  ]) {
    assert.equal(wrangler.includes(binding), false, `unexpected committed Access canary binding: ${binding}`);
  }
  assert.equal(
    pkg.scripts?.["cf:access-auth-canary-gate"],
    "node scripts/cloudflare-access-auth-canary-gate.mjs",
  );
});

test("Phase 3 documentation preserves the separate production authorization boundary", () => {
  assert.match(docs, /production Access auth canary activation gate/i);
  assert.match(docs, /PLAN/);
  assert.match(docs, /APPLY/);
  assert.match(docs, /separate explicit owner authorization/i);
  assert.match(docs, /Production deploy: NO/i);
});
