import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTINUATION_ACCESS_APP_NAME,
  CONTINUATION_ACCESS_DESTINATIONS,
  CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
  CONTINUATION_ACCESS_IDP_REFERENCE_URI,
  CONTINUATION_ACCESS_ISSUER,
  CONTINUATION_ACCESS_POLICY_NAME,
  nonTargetAccessInventoryDigest,
} from "./continuation-access-provisioning.mjs";
import { ContinuationAccessIdentityProviderError } from "./continuation-access-idp-readonly.mjs";
import {
  ContinuationAccessDirectIdpProofError,
  evaluateContinuationAccessDirectIdpPostflight,
  evaluateContinuationAccessDirectIdpPreflight,
} from "./continuation-access-direct-idp-proof.mjs";

const IDP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_IDP_ID = "55555555-5555-4555-8555-555555555555";
const UNRELATED_APP_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_APP_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_EMAIL = "owner@example.com";

function referenceApp(allowedIdps = []) {
  return {
    id: CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
    name: "Canonical owner login wildcard",
    type: "self_hosted",
    domain: CONTINUATION_ACCESS_IDP_REFERENCE_URI,
    destinations: [{ type: "public", uri: CONTINUATION_ACCESS_IDP_REFERENCE_URI }],
    allowed_idps: allowedIdps,
    aud: "reference-audience",
  };
}

function unrelatedApp() {
  return {
    id: UNRELATED_APP_ID,
    name: "Existing unrelated app",
    type: "self_hosted",
    domain: "control.rozkalns.net/api/github/merge",
    destinations: [{ type: "public", uri: "control.rozkalns.net/api/github/merge" }],
    aud: "existing-audience",
  };
}

function idpInventory() {
  return {
    success: true,
    result: [
      { id: IDP_ID, name: "Owner login", type: "cloudflare" },
      { id: OTHER_IDP_ID, name: "One-time PIN", type: "onetimepin" },
    ],
  };
}

function policiesBefore() {
  return {
    [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        name: "Family access",
        decision: "allow",
        precedence: 2,
        include: [{ email: { email: OWNER_EMAIL } }],
        require: [],
        exclude: [],
      },
    ],
    [UNRELATED_APP_ID]: [],
  };
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

function expectDirectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ContinuationAccessDirectIdpProofError && error.code === code);
}

test("direct IdP API evidence permits preflight when policy contains no IdP selector", () => {
  const apps = [referenceApp(), unrelatedApp()];
  const result = evaluateContinuationAccessDirectIdpPreflight({
    apps,
    policiesByApp: policiesBefore(),
    idpInventory: idpInventory(),
    expectedIdpId: IDP_ID,
    issuer: CONTINUATION_ACCESS_ISSUER,
    referenceApp: { success: true, result: referenceApp() },
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.conflictCount, 0);
  assert.equal(result.idp.id, IDP_ID);
  assert.equal(result.idp.source, "ACCESS_IDENTITY_PROVIDERS_API");
  assert.equal(result.idp.referenceConstraint, "EMPTY");
  assert.equal(result.idp.referenceAppId, CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID);
  assert.match(result.nonTargetDigest, /^[0-9a-f]{64}$/);
});

test("explicit selected IdP must exist in direct API inventory", () => {
  assert.throws(
    () => evaluateContinuationAccessDirectIdpPreflight({
      apps: [referenceApp(), unrelatedApp()],
      policiesByApp: policiesBefore(),
      idpInventory: { success: true, result: [{ id: OTHER_IDP_ID, name: "OTP", type: "onetimepin" }] },
      expectedIdpId: IDP_ID,
      issuer: CONTINUATION_ACCESS_ISSUER,
      referenceApp: { success: true, result: referenceApp() },
    }),
    (error) => error instanceof ContinuationAccessIdentityProviderError && error.code === "ACCESS_IDP_SELECTED_NOT_FOUND",
  );
});

test("reference app allowed_idps remains a fail-closed consistency constraint", () => {
  expectDirectCode(
    () => evaluateContinuationAccessDirectIdpPreflight({
      apps: [referenceApp([OTHER_IDP_ID]), unrelatedApp()],
      policiesByApp: policiesBefore(),
      idpInventory: idpInventory(),
      expectedIdpId: IDP_ID,
      issuer: CONTINUATION_ACCESS_ISSUER,
      referenceApp: { success: true, result: referenceApp([OTHER_IDP_ID]) },
    }),
    "ACCESS_IDP_REFERENCE_APP_MISMATCH",
  );
  expectDirectCode(
    () => evaluateContinuationAccessDirectIdpPreflight({
      apps: [referenceApp([IDP_ID, OTHER_IDP_ID]), unrelatedApp()],
      policiesByApp: policiesBefore(),
      idpInventory: idpInventory(),
      expectedIdpId: IDP_ID,
      issuer: CONTINUATION_ACCESS_ISSUER,
      referenceApp: { success: true, result: referenceApp([IDP_ID, OTHER_IDP_ID]) },
    }),
    "ACCESS_IDP_REFERENCE_ALLOWED_IDPS_MULTIPLE",
  );
});

test("direct IdP postflight preserves exact created app policy and non-target digest", () => {
  const beforeApps = [referenceApp(), unrelatedApp()];
  const beforePolicies = policiesBefore();
  const digest = nonTargetAccessInventoryDigest(beforeApps, beforePolicies);
  const app = createdApp();
  const result = evaluateContinuationAccessDirectIdpPostflight({
    apps: [...beforeApps, app],
    policiesByApp: { ...beforePolicies, [CREATED_APP_ID]: [createdPolicy()] },
    idpInventory: idpInventory(),
    createdAppId: CREATED_APP_ID,
    expectedIdpId: IDP_ID,
    ownerEmail: OWNER_EMAIL,
    issuer: CONTINUATION_ACCESS_ISSUER,
    expectedNonTargetDigest: digest,
    referenceApp: { success: true, result: referenceApp() },
    createdAppResponse: { success: true, result: app },
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.idp.source, "ACCESS_IDENTITY_PROVIDERS_API");
  assert.equal(result.appId, CREATED_APP_ID);
  assert.equal(result.policyId, POLICY_ID);
  assert.equal(result.nonTargetDigest, digest);
});

test("workflow contracts use direct IdP evidence for preflight and one-shot revalidation", () => {
  const preflight = readFileSync(new URL("../.github/workflows/continuation-access-readonly-preflight.yml", import.meta.url), "utf8");
  const provision = readFileSync(new URL("../.github/workflows/continuation-access-provision-one-shot.yml", import.meta.url), "utf8");
  for (const source of [preflight, provision]) {
    assert.match(source, /CLOUDFLARE_ACCESS_IDP_READ_TOKEN/);
    assert.match(source, /continuation-access-direct-idp-proof\.mjs preflight/);
    assert.match(source, /ACCESS_IDENTITY_PROVIDERS_API/);
  }
  assert.match(provision, /continuation-access-direct-idp-proof\.mjs postflight/);
  assert.doesNotMatch(preflight, /continuation-access-provisioning\.mjs reference-idp/);
  assert.doesNotMatch(preflight, /ACCESS_POLICY_POSITIVE_HUMAN_IDP/);
  assert.doesNotMatch(provision, /ACCESS_POLICY_POSITIVE_HUMAN_IDP/);
});
