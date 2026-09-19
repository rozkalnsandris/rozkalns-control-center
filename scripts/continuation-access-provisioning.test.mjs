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
  ContinuationAccessProvisioningError,
  buildContinuationAccessApplicationPayload,
  canonicalIdentityProviderReference,
  continuationAccessApplicationConflicts,
  evaluateContinuationAccessPostflight,
  evaluateContinuationAccessPreflight,
  nonTargetAccessInventoryDigest,
} from "./continuation-access-provisioning.mjs";

const IDP_ID = "11111111-1111-4111-8111-111111111111";
const UNRELATED_APP_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_APP_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_EMAIL = "owner@example.com";

function referenceApp(overrides = {}) {
  return {
    id: CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
    name: "Canonical owner login wildcard",
    type: "self_hosted",
    domain: CONTINUATION_ACCESS_IDP_REFERENCE_URI,
    destinations: [{ type: "public", uri: CONTINUATION_ACCESS_IDP_REFERENCE_URI }],
    allowed_idps: [IDP_ID],
    aud: "reference-audience",
    ...overrides,
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

function beforeApps() {
  return [referenceApp(), unrelatedApp()];
}

function beforePolicies() {
  return {
    [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: [],
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

test("canonical human Access app exposes exactly one explicit IdP reference", () => {
  const reference = canonicalIdentityProviderReference(beforeApps());
  assert.deepEqual(reference, {
    id: IDP_ID,
    referenceAppId: CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
    referenceUri: CONTINUATION_ACCESS_IDP_REFERENCE_URI,
  });

  expectCode(
    () => canonicalIdentityProviderReference([unrelatedApp()]),
    "ACCESS_IDP_REFERENCE_APP_NOT_EXACT",
  );
  expectCode(
    () => canonicalIdentityProviderReference([referenceApp({ allowed_idps: [] })]),
    "ACCESS_IDP_REFERENCE_NOT_EXACT",
  );
  expectCode(
    () => canonicalIdentityProviderReference([referenceApp({ allowed_idps: [IDP_ID, "55555555-5555-4555-8555-555555555555"] })]),
    "ACCESS_IDP_REFERENCE_NOT_EXACT",
  );
  expectCode(
    () => canonicalIdentityProviderReference([referenceApp({ destinations: [{ type: "public", uri: "control.rozkalns.net" }] })]),
    "ACCESS_IDP_REFERENCE_APP_DESTINATION_INVALID",
  );
});

test("preflight passes only with vacant exact targets, canonical IdP reference and reviewed issuer", () => {
  const result = evaluateContinuationAccessPreflight({
    apps: beforeApps(),
    policiesByApp: beforePolicies(),
    expectedIdpId: IDP_ID,
    issuer: CONTINUATION_ACCESS_ISSUER,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.conflictCount, 0);
  assert.equal(result.idp.id, IDP_ID);
  assert.equal(result.idp.referenceAppId, CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID);
  assert.equal(result.issuer, CONTINUATION_ACCESS_ISSUER);
  assert.match(result.nonTargetDigest, /^[0-9a-f]{64}$/);

  expectCode(
    () =>
      evaluateContinuationAccessPreflight({
        apps: beforeApps(),
        policiesByApp: beforePolicies(),
        expectedIdpId: "55555555-5555-4555-8555-555555555555",
        issuer: CONTINUATION_ACCESS_ISSUER,
      }),
    "ACCESS_IDP_REFERENCE_CHANGED",
  );
  expectCode(
    () =>
      evaluateContinuationAccessPreflight({
        apps: beforeApps(),
        policiesByApp: beforePolicies(),
        expectedIdpId: IDP_ID,
        issuer: "https://unreviewed.cloudflareaccess.com",
      }),
    "ACCESS_ISSUER_NOT_REVIEWED",
  );
});

test("reserved name or either exact destination blocks preflight", () => {
  const conflictId = "66666666-6666-4666-8666-666666666666";
  const byName = { ...unrelatedApp(), id: conflictId, name: CONTINUATION_ACCESS_APP_NAME };
  assert.equal(continuationAccessApplicationConflicts([byName]).length, 1);

  for (const uri of CONTINUATION_ACCESS_DESTINATIONS) {
    const app = {
      ...unrelatedApp(),
      id: conflictId,
      domain: uri,
      destinations: [{ type: "public", uri }],
    };
    assert.equal(continuationAccessApplicationConflicts([app]).length, 1);
    expectCode(
      () =>
        evaluateContinuationAccessPreflight({
          apps: [referenceApp(), app],
          policiesByApp: { [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: [], [conflictId]: [] },
          expectedIdpId: IDP_ID,
          issuer: CONTINUATION_ACCESS_ISSUER,
        }),
      "ACCESS_CONTINUATION_TARGET_CONFLICT",
    );
  }
});

test("inventory digest is stable across app order and object key order", () => {
  const first = referenceApp();
  const second = unrelatedApp();
  const policies = {
    [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: [{ id: POLICY_ID, name: "p", decision: "allow" }],
    [UNRELATED_APP_ID]: [],
  };
  const digestA = nonTargetAccessInventoryDigest([first, second], policies);
  const digestB = nonTargetAccessInventoryDigest(
    [
      { destinations: second.destinations, aud: second.aud, domain: second.domain, type: second.type, id: second.id, name: second.name },
      {
        allowed_idps: first.allowed_idps,
        destinations: first.destinations,
        aud: first.aud,
        domain: first.domain,
        type: first.type,
        name: first.name,
        id: first.id,
      },
    ],
    { [UNRELATED_APP_ID]: [], [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: [{ decision: "allow", name: "p", id: POLICY_ID }] },
  );
  assert.equal(digestA, digestB);
});

test("postflight proves exact created app/policy and unchanged non-target state", () => {
  const expectedDigest = nonTargetAccessInventoryDigest(beforeApps(), beforePolicies());
  const afterApps = [createdApp(), ...beforeApps()];
  const afterPolicies = {
    [CREATED_APP_ID]: [createdPolicy()],
    ...beforePolicies(),
  };
  const result = evaluateContinuationAccessPostflight({
    apps: afterApps,
    policiesByApp: afterPolicies,
    createdAppId: CREATED_APP_ID,
    expectedIdpId: IDP_ID,
    ownerEmail: OWNER_EMAIL,
    issuer: CONTINUATION_ACCESS_ISSUER,
    expectedNonTargetDigest: expectedDigest,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.appId, CREATED_APP_ID);
  assert.equal(result.policyId, POLICY_ID);
  assert.equal(result.audience, "new_audience-123");
  assert.equal(result.idp.referenceAppId, CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID);
  assert.equal(result.issuer, CONTINUATION_ACCESS_ISSUER);
  assert.equal(result.nonTargetDigest, expectedDigest);
});

test("postflight fails closed on broadened owner policy, IdP reference drift or non-target drift", () => {
  const expectedDigest = nonTargetAccessInventoryDigest(beforeApps(), beforePolicies());
  const broadened = createdPolicy();
  broadened.include.push({ everyone: {} });
  expectCode(
    () =>
      evaluateContinuationAccessPostflight({
        apps: [...beforeApps(), createdApp()],
        policiesByApp: { ...beforePolicies(), [CREATED_APP_ID]: [broadened] },
        createdAppId: CREATED_APP_ID,
        expectedIdpId: IDP_ID,
        ownerEmail: OWNER_EMAIL,
        issuer: CONTINUATION_ACCESS_ISSUER,
        expectedNonTargetDigest: expectedDigest,
      }),
    "ACCESS_CREATED_POLICY_OWNER_SELECTOR_INVALID",
  );

  expectCode(
    () =>
      evaluateContinuationAccessPostflight({
        apps: [referenceApp({ allowed_idps: ["55555555-5555-4555-8555-555555555555"] }), unrelatedApp(), createdApp()],
        policiesByApp: { ...beforePolicies(), [CREATED_APP_ID]: [createdPolicy()] },
        createdAppId: CREATED_APP_ID,
        expectedIdpId: IDP_ID,
        ownerEmail: OWNER_EMAIL,
        issuer: CONTINUATION_ACCESS_ISSUER,
        expectedNonTargetDigest: expectedDigest,
      }),
    "ACCESS_IDP_REFERENCE_CHANGED",
  );

  const driftedUnrelated = { ...unrelatedApp(), name: "Unexpected drift" };
  expectCode(
    () =>
      evaluateContinuationAccessPostflight({
        apps: [referenceApp(), driftedUnrelated, createdApp()],
        policiesByApp: { ...beforePolicies(), [CREATED_APP_ID]: [createdPolicy()] },
        createdAppId: CREATED_APP_ID,
        expectedIdpId: IDP_ID,
        ownerEmail: OWNER_EMAIL,
        issuer: CONTINUATION_ACCESS_ISSUER,
        expectedNonTargetDigest: expectedDigest,
      }),
    "ACCESS_NON_TARGET_DIGEST_CHANGED",
  );
});

test("read-only workflow uses only Apps/Policies token capability plus public reviewed issuer proof", () => {
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
  assert.match(workflow, /reference-idp/);
  assert.match(workflow, /CONTINUATION_ACCESS_IDP_INVENTORY=PASS/);
  assert.match(workflow, /IDP_REFERENCE_SOURCE=ACCESS_APP_ALLOWED_IDPS/);
  assert.match(workflow, /ACCESS_ISSUER: https:\/\/super-salad-2357\.cloudflareaccess\.com/);
  assert.match(workflow, /\/cdn-cgi\/access\/certs/);
  assert.match(workflow, /\/access\/apps/);
  assert.match(workflow, /ACCESS_API_METHOD=GET_ONLY/);
  assert.match(workflow, /PRODUCTION_MUTATIONS=0/);
  assert.match(workflow, /CLOUDFLARE_ACCESS_MUTATION=NO/);
  assert.match(workflow, /CLOUDFLARE_ACCESS_READ_TOKEN/);
  assert.doesNotMatch(workflow, /\/access\/identity_providers/);
  assert.doesNotMatch(workflow, /\/access\/organizations/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_ACCESS_WRITE_TOKEN/);
  assert.doesNotMatch(workflow, /curl[^\n]*\s-X\s+(POST|PUT|PATCH|DELETE)\b/i);
});

test("one-shot revalidation does not depend on IdP/organization permission family", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/continuation-access-provision-one-shot.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /ACCESS_ISSUER: https:\/\/super-salad-2357\.cloudflareaccess\.com/);
  assert.match(workflow, /\/cdn-cgi\/access\/certs/);
  assert.match(workflow, /\/access\/apps/);
  assert.match(workflow, /IDP_REFERENCE_APP_ID=235c0666-9e1b-45a2-a7a2-63433c8a2247/);
  assert.match(workflow, /\.event == "workflow_dispatch" or \.event == "issue_comment"/);
  assert.doesNotMatch(workflow, /\/access\/identity_providers/);
  assert.doesNotMatch(workflow, /\/access\/organizations/);
});
