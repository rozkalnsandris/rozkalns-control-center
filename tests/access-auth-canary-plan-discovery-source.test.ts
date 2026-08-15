import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const plan = readFileSync(resolve(process.cwd(), "scripts/cloudflare-access-auth-canary-plan.mjs"), "utf8");
const applyGate = readFileSync(resolve(process.cwd(), "scripts/cloudflare-access-auth-canary-gate.mjs"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

test("PLAN-only entrypoint cannot reach Worker deploy or Cloudflare writes", () => {
  assert.equal(
    pkg.scripts?.["cf:access-auth-canary-plan"],
    "node scripts/cloudflare-access-auth-canary-plan.mjs",
  );
  assert.match(plan, /CLOUDFLARE_MUTATION=NO/);
  assert.match(plan, /WORKER_DEPLOY=NOT_EXECUTED_IN_PLAN/);
  assert.match(plan, /AUTHORIZATION_STATUS=NOT_CONSUMED/);
  assert.doesNotMatch(plan, /\["deploy"/);
  assert.doesNotMatch(plan, /\bcfWrite\b/);
  assert.doesNotMatch(plan, /CONTROL_OWNER_AUTHORIZATION/);
});

test("PLAN selects the parent by token AUD before host coverage proof and cryptographic re-bind", () => {
  const hint = plan.indexOf("readAccessTokenApplicationAudience(accessToken)");
  const select = plan.indexOf("exactParentAccessApplication(apps, audienceHint)");
  const destination = plan.indexOf("accessApplicationProtectsHost(parent, HOSTNAME)");
  const verify = plan.indexOf("verifyShortLivedAccessToken(accessToken, parent.aud)");

  assert.ok(hint >= 0, "missing token AUD hint extraction");
  assert.ok(select > hint, "parent selection must follow bounded AUD hint extraction");
  assert.ok(destination > select, "Control hostname coverage proof must follow exact AUD selection");
  assert.ok(verify > destination, "RS256/JWKS verification must re-bind the selected app after destination proof");
  assert.match(plan, /verified Access audience did not re-bind to the AUD-selected parent application/);
  assert.match(plan, /PARENT_DISCOVERY=TOKEN_AUD_THEN_SIGNATURE_REBIND/);
});

test("PLAN retains exact RS256 issuer/JWKS and preactivation checks", () => {
  assert.match(plan, /verify\("RSA-SHA256"/);
  assert.match(plan, /\/cdn-cgi\/access\/certs/);
  assert.match(plan, /\.cloudflareaccess\.com/);
  assert.match(plan, /ACCESS_TOKEN_SIGNATURE=VERIFIED_RS256_JWKS/);
  assert.match(plan, /pre-activation canary must be absent or fail-closed disabled/);
  assert.match(plan, /protected health request did not return HTTP 200/);
});

test("PLAN authorization shape remains compatible with the existing APPLY gate", () => {
  for (const fragment of [
    "authorize Phase 3 Access auth canary",
    " ci ",
    " version ",
    " deployment ",
    " domain ",
    " access ",
    " aud ",
    " issuer ",
    " mainq ",
    " mainc ",
    " dlq ",
    " dlqc ",
    " inactive",
  ]) {
    assert.ok(plan.includes(fragment), `PLAN authorization missing ${fragment}`);
    assert.ok(applyGate.includes(fragment), `APPLY authorization missing ${fragment}`);
  }
});
