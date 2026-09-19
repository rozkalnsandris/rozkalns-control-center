import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTINUATION_ACCESS_APP_NAME,
  CONTINUATION_ACCESS_DESTINATIONS,
  CONTINUATION_ACCESS_POLICY_NAME,
  ContinuationAccessProvisioningError,
  buildContinuationAccessApplicationPayload,
  continuationAccessApplicationConflicts,
  evaluateContinuationAccessPostflight,
  evaluateContinuationAccessPreflight,
  nonTargetAccessInventoryDigest,
} from "./continuation-access-provisioning.mjs";

const IDP_ID = "11111111-1111-4111-8111-111111111111";
const EXISTING_APP_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_APP_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_EMAIL = "owner@example.com";

function existingApp() {
  return {
    id: EXISTING_APP_ID,
    name: "Existing unrelated app",
    type: "self_hosted",
    domain: "control.rozkalns.net/api/github/merge",
    destinations: [{ type: "public", uri: "control.rozkalns.net/api/github/merge" }],
    aud: "existing-audience",
  };
}

function idps() {
  return [{ id: IDP_ID, name: "Existing login", type: "github" }];
}

function organization() {
  return { auth_domain: "rozkalns.cloudflareaccess.com" };
}

function createdApp() {
  return {
    id: CREATED_APP_ID,
    name: CONTINUATION_ACCESS_APP_NAME,
    type: "self_hosted",
    domain: CONTINUATION_ACCESS_DESTINATIONS[0],
    destinations: CONTINUATION_ACCESS_DESTINATIONS.map((uri) => ({ type: "public", uri })),
    allowed_idps: [IDP_ID],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    allow_authenticate_via_warp: false,
    aud: "new_audience-123",
  };
}

function createdPolicy() {
  return {
    id: POLICY_ID,
    name: CONTINUATION_ACCESS_POLICY_NAME,
    decision: "allow",
    precedence: 1,
    include: [{ email: { email: OWNER_EMAIL } }],
    exclude: [],
    require: [],
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ContinuationAccessProvisioningError && error.code === code);
}

test("payload is one bounded self-hosted app with one private owner allow policy", () => {
  const payload = buildContinuationAccessApplicationPayload(IDP_ID, OWNER_EMAIL);
  assert.equal(payload.name, CONTINUATION_ACCESS_APP_NAME);
  assert.equal(payload.type, "self_hosted");
  assert.equal(payload.domain, CONTINUATION_ACCESS_DESTINATIONS[0]);
  assert.deepEqual(
    payload.destinations,
    CONTINUATION_ACCESS_DESTINATIONS.map((uri) => ({ type: "public", uri })),
  );
  assert.ok(payload.destinations.every(({ uri }) => !uri.includes("*")));
  assert.deepEqual(payload.allowed_idps, [IDP_ID]);
  assert.equal(payload.auto_redirect_to_identity, true);
  assert.equal(payload.app_launcher_visible, false);
  assert.equal(payload.allow_authenticate_via_warp, false);
  assert.equal(payload.policies.length, 1);
  assert.deepEqual(payload.policies[0], {
    name: CONTINUATION_ACCESS_POLICY_NAME,
    decision: "allow",
    precedence: 1,
    include: [{ email: { email: OWNER_EMAIL } }],
  });
});

test("preflight passes only with vacant exact targets and one selected existing IdP", () => {
  const apps = [existingApp()];
  const policiesByApp = { [EXISTING_APP_ID]: [] };
  const result = evaluateContinuationAccessPreflight({
    apps,
    policiesByApp,
    identityProviders: idps(),
    expectedIdpId: IDP_ID,
    organization: organization(),
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.conflictCount, 0);
  assert.equal(result.idp.id, IDP_ID);
  assert.equal(result.issuer, "https://rozkalns.cloudflareaccess.com");
  assert.match(result.nonTargetDigest, /^[0-9a-f]{64}$/);
});

test("reserved name or either exact destination blocks preflight", () => {
  const byName = { ...existingApp(), name: CONTINUATION_ACCESS_APP_NAME };
  assert.equal(continuationAccessApplicationConflicts([byName]).length, 1);

  for (const uri of CONTINUATION_ACCESS_DESTINATIONS) {
    const app = {
      ...existingApp(),
      domain: uri,
      destinations: [{ type: "public", uri }],
    };
    assert.equal(continuationAccessApplicationConflicts([app]).length, 1);
    expectCode(
      () =>
        evaluateContinuationAccessPreflight({
          apps: [app],
          policiesByApp: { [EXISTING_APP_ID]: [] },
          identityProviders: idps(),
          expectedIdpId: IDP_ID,
          organization: organization(),
        }),
      "ACCESS_CONTINUATION_TARGET_CONFLICT",
    );
  }
});

test("inventory digest is stable across app order and object key order", () => {
  const secondId = "55555555-5555-4555-8555-555555555555";
  const first = existingApp();
  const second = {
    name: "Second app",
    id: secondId,
    type: "self_hosted",
    domain: "control.rozkalns.net/second",
  };
  const policies = {
    [EXISTING_APP_ID]: [{ id: POLICY_ID, name: "p", decision: "allow" }],
    [secondId]: [],
  };
  const digestA = nonTargetAccessInventoryDigest([first, second], policies);
  const digestB = nonTargetAccessInventoryDigest(
    [
      { domain: second.domain, type: second.type, id: second.id, name: second.name },
      { aud: first.aud, destinations: first.destinations, domain: first.domain, type: first.type, name: first.name, id: first.id },
    ],
    { [secondId]: [], [EXISTING_APP_ID]: [{ decision: "allow", name: "p", id: POLICY_ID }] },
  );
  assert.equal(digestA, digestB);
});

test("postflight proves exact created app/policy and unchanged non-target state", () => {
  const beforeApps = [existingApp()];
  const beforePolicies = { [EXISTING_APP_ID]: [] };
  const expectedDigest = nonTargetAccessInventoryDigest(beforeApps, beforePolicies);
  const afterApps = [createdApp(), existingApp()];
  const afterPolicies = {
    [CREATED_APP_ID]: [createdPolicy()],
    [EXISTING_APP_ID]: [],
  };
  const result = evaluateContinuationAccessPostflight({
    apps: afterApps,
    policiesByApp: afterPolicies,
    createdAppId: CREATED_APP_ID,
    expectedIdpId: IDP_ID,
    ownerEmail: OWNER_EMAIL,
    organization: organization(),
    expectedNonTargetDigest: expectedDigest,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.appId, CREATED_APP_ID);
  assert.equal(result.policyId, POLICY_ID);
  assert.equal(result.audience, "new_audience-123");
  assert.equal(result.nonTargetDigest, expectedDigest);
});

test("postflight fails closed on broadened owner policy or non-target drift", () => {
  const beforeApps = [existingApp()];
  const expectedDigest = nonTargetAccessInventoryDigest(beforeApps, { [EXISTING_APP_ID]: [] });
  const broadened = createdPolicy();
  broadened.include.push({ everyone: {} });
  expectCode(
    () =>
      evaluateContinuationAccessPostflight({
        apps: [existingApp(), createdApp()],
        policiesByApp: { [EXISTING_APP_ID]: [], [CREATED_APP_ID]: [broadened] },
        createdAppId: CREATED_APP_ID,
        expectedIdpId: IDP_ID,
        ownerEmail: OWNER_EMAIL,
        organization: organization(),
        expectedNonTargetDigest: expectedDigest,
      }),
    "ACCESS_CREATED_POLICY_OWNER_SELECTOR_INVALID",
  );

  const driftedExisting = { ...existingApp(), name: "Unexpected drift" };
  expectCode(
    () =>
      evaluateContinuationAccessPostflight({
        apps: [driftedExisting, createdApp()],
        policiesByApp: { [EXISTING_APP_ID]: [], [CREATED_APP_ID]: [createdPolicy()] },
        createdAppId: CREATED_APP_ID,
        expectedIdpId: IDP_ID,
        ownerEmail: OWNER_EMAIL,
        organization: organization(),
        expectedNonTargetDigest: expectedDigest,
      }),
    "ACCESS_NON_TARGET_DIGEST_CHANGED",
  );
});

test("read-only workflow owner-comment path is fixed, bounded and mutation-free", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/continuation-access-readonly-preflight.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /issue_comment:\n\s+types: \[created\]/);
  assert.match(workflow, /github\.event\.issue\.number == 278/);
  assert.match(workflow, /github\.event\.issue\.pull_request == null/);
  assert.match(workflow, /github\.event\.comment\.user\.id == 277435981/);
  assert.match(workflow, /github\.event\.comment\.user\.type == 'User'/);
  assert.match(workflow, /\/continuation-access-idp-inventory/);
  assert.match(workflow, /\/continuation-access-preflight:/);
  assert.match(workflow, /ACCESS_IDP_PUBLIC_INVENTORY_UNBOUNDED/);
  assert.match(workflow, /CONTINUATION_ACCESS_IDP_INVENTORY=PASS/);
  assert.match(workflow, /ACCESS_API_METHOD=GET_ONLY/);
  assert.match(workflow, /PRODUCTION_MUTATIONS=0/);
  assert.match(workflow, /CLOUDFLARE_ACCESS_MUTATION=NO/);
  assert.match(workflow, /CLOUDFLARE_ACCESS_READ_TOKEN/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_ACCESS_WRITE_TOKEN/);
  assert.doesNotMatch(workflow, /curl[^\n]*\s-X\s+(POST|PUT|PATCH|DELETE)\b/i);
});
