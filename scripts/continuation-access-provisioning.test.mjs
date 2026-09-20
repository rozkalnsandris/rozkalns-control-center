import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTINUATION_ACCESS_APP_NAME,
  CONTINUATION_ACCESS_DESTINATIONS,
  CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
  CONTINUATION_ACCESS_IDP_REFERENCE_SOURCE,
  CONTINUATION_ACCESS_IDP_REFERENCE_URI,
  CONTINUATION_ACCESS_ISSUER,
  CONTINUATION_ACCESS_POLICY_NAME,
  ContinuationAccessProvisioningError,
  buildContinuationAccessApplicationPayload,
  canonicalIdentityProviderReference,
  classifyExactIdentityProviderReference,
  classifyPolicyIdentityProviderReference,
  continuationAccessApplicationConflicts,
  evaluateContinuationAccessPostflight,
  evaluateContinuationAccessPreflight,
  nonTargetAccessInventoryDigest,
} from "./continuation-access-provisioning.mjs";

const IDP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_IDP_ID = "55555555-5555-4555-8555-555555555555";
const UNRELATED_APP_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_APP_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const REFERENCE_POLICY_ID = "77777777-7777-4777-8777-777777777777";
const OWNER_EMAIL = "owner@example.com";

function referenceApp(overrides = {}) {
  return {
    id: CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
    name: "Canonical owner login wildcard",
    type: "self_hosted",
    domain: CONTINUATION_ACCESS_IDP_REFERENCE_URI,
    destinations: [{ type: "public", uri: CONTINUATION_ACCESS_IDP_REFERENCE_URI }],
    allowed_idps: [],
    aud: "reference-audience",
    ...overrides,
  };
}

function referencePolicy(overrides = {}) {
  return {
    id: REFERENCE_POLICY_ID,
    name: "Family access",
    decision: "allow",
    precedence: 2,
    include: [{ login_method: { id: IDP_ID } }],
    require: [],
    exclude: [],
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

function beforePolicies(referencePolicies = [referencePolicy()]) {
  return {
    [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: referencePolicies,
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
  assert.deepEqual(payload.policies, [
    {
      name: CONTINUATION_ACCESS_POLICY_NAME,
      decision: "allow",
      precedence: 1,
      include: [{ email: { email: OWNER_EMAIL } }],
    },
  ]);
});

test("positive human Access policy evidence resolves exactly one IdP", () => {
  const reference = canonicalIdentityProviderReference(beforeApps(), beforePolicies());
  assert.deepEqual(reference, {
    id: IDP_ID,
    referenceAppId: CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
    referenceUri: CONTINUATION_ACCESS_IDP_REFERENCE_URI,
    source: CONTINUATION_ACCESS_IDP_REFERENCE_SOURCE,
  });

  assert.deepEqual(classifyPolicyIdentityProviderReference([referencePolicy()]), {
    classification: "ONE",
    count: 1,
    evidenceRuleCount: 1,
    id: IDP_ID,
    source: CONTINUATION_ACCESS_IDP_REFERENCE_SOURCE,
  });
  assert.deepEqual(
    classifyPolicyIdentityProviderReference([
      referencePolicy({
        include: [{ email: { email: OWNER_EMAIL } }],
        require: [{ github: { identity_provider_id: IDP_ID, organization: "example" } }],
      }),
    ]),
    {
      classification: "ONE",
      count: 1,
      evidenceRuleCount: 1,
      id: IDP_ID,
      source: CONTINUATION_ACCESS_IDP_REFERENCE_SOURCE,
    },
  );
  assert.equal(
    classifyPolicyIdentityProviderReference([
      referencePolicy({
        include: [{ login_method: { id: IDP_ID } }],
        require: [{ okta: { identity_provider_id: IDP_ID, name: "owners" } }],
      }),
    ]).classification,
    "ONE",
  );
});

test("policy IdP evidence fails closed on zero multiple malformed or exclude-only selectors", () => {
  assert.deepEqual(
    classifyPolicyIdentityProviderReference([
      referencePolicy({ include: [{ email: { email: OWNER_EMAIL } }], require: [], exclude: [{ login_method: { id: IDP_ID } }] }),
    ]),
    { classification: "ZERO", count: 0, evidenceRuleCount: 0 },
  );
  assert.deepEqual(
    classifyPolicyIdentityProviderReference([
      referencePolicy({ include: [{ login_method: { id: IDP_ID } }, { login_method: { id: OTHER_IDP_ID } }] }),
    ]),
    { classification: "MULTIPLE", count: 2, evidenceRuleCount: 2 },
  );
  expectCode(
    () => classifyPolicyIdentityProviderReference([referencePolicy({ include: [{ login_method: {} }] })]),
    "ACCESS_IDP_POLICY_LOGIN_METHOD_INVALID",
  );
  expectCode(
    () => classifyPolicyIdentityProviderReference([referencePolicy({ include: [{ github: { identity_provider_id: "not-a-uuid" } }] })]),
    "ACCESS_IDP_POLICY_ID_INVALID",
  );
  expectCode(
    () => classifyPolicyIdentityProviderReference([referencePolicy({ include: [{ wrapper: { nested: { identity_provider_id: IDP_ID } } }] })]),
    "ACCESS_IDP_POLICY_SELECTOR_UNSUPPORTED",
  );
  expectCode(
    () => canonicalIdentityProviderReference(beforeApps(), beforePolicies([])),
    "ACCESS_IDP_REFERENCE_POLICY_ZERO",
  );
  expectCode(
    () =>
      canonicalIdentityProviderReference(
        beforeApps(),
        beforePolicies([
          referencePolicy(),
          referencePolicy({ id: "88888888-8888-4888-8888-888888888888", include: [{ login_method: { id: OTHER_IDP_ID } }] }),
        ]),
      ),
    "ACCESS_IDP_REFERENCE_POLICY_MULTIPLE",
  );
});

test("exact app allowed_idps is only a consistency constraint on policy-derived evidence", () => {
  const absent = referenceApp();
  delete absent.allowed_idps;
  assert.deepEqual(classifyExactIdentityProviderReference(absent), { classification: "ABSENT", count: 0 });
  assert.deepEqual(classifyExactIdentityProviderReference(referenceApp()), { classification: "EMPTY", count: 0 });
  assert.deepEqual(classifyExactIdentityProviderReference(referenceApp({ allowed_idps: [IDP_ID] })), {
    classification: "ONE",
    count: 1,
    id: IDP_ID,
  });
  assert.deepEqual(
    classifyExactIdentityProviderReference(referenceApp({ allowed_idps: [IDP_ID, OTHER_IDP_ID] })),
    { classification: "MULTIPLE", count: 2 },
  );

  assert.equal(canonicalIdentityProviderReference(beforeApps(), beforePolicies(), absent).id, IDP_ID);
  assert.equal(
    canonicalIdentityProviderReference(beforeApps(), beforePolicies(), referenceApp({ allowed_idps: [IDP_ID] })).id,
    IDP_ID,
  );
  expectCode(
    () => canonicalIdentityProviderReference(beforeApps(), beforePolicies(), referenceApp({ allowed_idps: [OTHER_IDP_ID] })),
    "ACCESS_IDP_REFERENCE_APP_POLICY_MISMATCH",
  );
  expectCode(
    () => canonicalIdentityProviderReference(beforeApps(), beforePolicies(), referenceApp({ allowed_idps: [IDP_ID, OTHER_IDP_ID] })),
    "ACCESS_IDP_REFERENCE_ALLOWED_IDPS_MULTIPLE",
  );

  const helper = readFileSync(new URL("./continuation-access-provisioning.mjs", import.meta.url), "utf8");
  assert.match(helper, /\/access\/apps\/\$\{CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID\}\/policies\?per_page=100&page=\$\{page\}/);
  assert.match(helper, /method: "GET"/);
  assert.match(helper, /CLOUDFLARE_ACCESS_READ_TOKEN/);
  assert.doesNotMatch(helper, /\/access\/identity_providers/);
  assert.doesNotMatch(helper, /\/access\/organizations/);
});

test("preflight passes only with vacant exact targets policy-derived IdP and reviewed issuer", () => {
  const result = evaluateContinuationAccessPreflight({
    apps: beforeApps(),
    policiesByApp: beforePolicies(),
    expectedIdpId: IDP_ID,
    issuer: CONTINUATION_ACCESS_ISSUER,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.conflictCount, 0);
  assert.equal(result.idp.id, IDP_ID);
  assert.equal(result.idp.source, CONTINUATION_ACCESS_IDP_REFERENCE_SOURCE);
  assert.equal(result.idp.referenceAppId, CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID);
  assert.equal(result.issuer, CONTINUATION_ACCESS_ISSUER);
  assert.match(result.nonTargetDigest, /^[0-9a-f]{64}$/);

  expectCode(
    () => evaluateContinuationAccessPreflight({ apps: beforeApps(), policiesByApp: beforePolicies(), expectedIdpId: OTHER_IDP_ID, issuer: CONTINUATION_ACCESS_ISSUER }),
    "ACCESS_IDP_REFERENCE_CHANGED",
  );
  expectCode(
    () => evaluateContinuationAccessPreflight({ apps: beforeApps(), policiesByApp: beforePolicies(), expectedIdpId: IDP_ID, issuer: "https://unreviewed.cloudflareaccess.com" }),
    "ACCESS_ISSUER_NOT_REVIEWED",
  );
});

test("reserved name or either exact destination blocks preflight", () => {
  const conflictId = "66666666-6666-4666-8666-666666666666";
  const byName = { ...unrelatedApp(), id: conflictId, name: CONTINUATION_ACCESS_APP_NAME };
  assert.equal(continuationAccessApplicationConflicts([byName]).length, 1);

  for (const uri of CONTINUATION_ACCESS_DESTINATIONS) {
    const app = { ...unrelatedApp(), id: conflictId, domain: uri, destinations: [{ type: "public", uri }] };
    assert.equal(continuationAccessApplicationConflicts([app]).length, 1);
    expectCode(
      () => evaluateContinuationAccessPreflight({
        apps: [referenceApp(), app],
        policiesByApp: { [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: [referencePolicy()], [conflictId]: [] },
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
  const policy = referencePolicy();
  const policies = { [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: [policy], [UNRELATED_APP_ID]: [] };
  const digestA = nonTargetAccessInventoryDigest([first, second], policies);
  const digestB = nonTargetAccessInventoryDigest(
    [
      { destinations: second.destinations, aud: second.aud, domain: second.domain, type: second.type, id: second.id, name: second.name },
      { allowed_idps: first.allowed_idps, destinations: first.destinations, aud: first.aud, domain: first.domain, type: first.type, name: first.name, id: first.id },
    ],
    { [UNRELATED_APP_ID]: [], [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: [{ exclude: [], require: [], include: policy.include, precedence: 2, decision: "allow", name: "Family access", id: REFERENCE_POLICY_ID }] },
  );
  assert.equal(digestA, digestB);
});

test("postflight proves exact created app policy source and unchanged non-target state", () => {
  const expectedDigest = nonTargetAccessInventoryDigest(beforeApps(), beforePolicies());
  const afterApps = [createdApp(), ...beforeApps()];
  const afterPolicies = { [CREATED_APP_ID]: [createdPolicy()], ...beforePolicies() };
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
  assert.equal(result.idp.source, CONTINUATION_ACCESS_IDP_REFERENCE_SOURCE);
  assert.equal(result.nonTargetDigest, expectedDigest);
});

test("postflight fails closed on broadened owner policy IdP drift or non-target drift", () => {
  const expectedDigest = nonTargetAccessInventoryDigest(beforeApps(), beforePolicies());
  const broadened = createdPolicy();
  broadened.include.push({ everyone: {} });
  expectCode(
    () => evaluateContinuationAccessPostflight({
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
    () => evaluateContinuationAccessPostflight({
      apps: [...beforeApps(), createdApp()],
      policiesByApp: { ...beforePolicies([referencePolicy({ include: [{ login_method: { id: OTHER_IDP_ID } }] })]), [CREATED_APP_ID]: [createdPolicy()] },
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
    () => evaluateContinuationAccessPostflight({
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

test("read-only workflow keeps Apps Policies read boundary and binds policy-derived IdP source", () => {
  const workflow = readFileSync(new URL("../.github/workflows/continuation-access-readonly-preflight.yml", import.meta.url), "utf8");
  assert.match(workflow, /issue_comment:\n\s+types: \[created\]/);
  assert.match(workflow, /github\.event\.issue\.number == 278/);
  assert.match(workflow, /\/continuation-access-idp-inventory/);
  assert.match(workflow, /\/continuation-access-preflight:/);
  assert.match(workflow, /reference-idp/);
  assert.match(workflow, /CONTINUATION_ACCESS_IDP_INVENTORY=PASS/);
  assert.match(workflow, /IDP_REFERENCE_SOURCE=ACCESS_POLICY_POSITIVE_HUMAN_IDP/);
  assert.match(workflow, /\.idp\.source == "ACCESS_POLICY_POSITIVE_HUMAN_IDP"/);
  assert.match(workflow, /ACCESS_ISSUER: https:\/\/super-salad-2357\.cloudflareaccess\.com/);
  assert.match(workflow, /\/cdn-cgi\/access\/certs/);
  assert.match(workflow, /\/access\/apps/);
  assert.match(workflow, /ACCESS_API_METHOD=GET_ONLY/);
  assert.match(workflow, /PRODUCTION_MUTATIONS=0/);
  assert.match(workflow, /CLOUDFLARE_ACCESS_READ_TOKEN/);
  assert.doesNotMatch(workflow, /\/access\/identity_providers/);
  assert.doesNotMatch(workflow, /\/access\/organizations/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_ACCESS_WRITE_TOKEN/);
  assert.doesNotMatch(workflow, /curl[^\n]*\s-X\s+(POST|PUT|PATCH|DELETE)\b/i);
});

test("one-shot binds the same policy-derived source without IdP organization permission expansion", () => {
  const workflow = readFileSync(new URL("../.github/workflows/continuation-access-provision-one-shot.yml", import.meta.url), "utf8");
  assert.match(workflow, /IDP_REFERENCE_SOURCE=ACCESS_POLICY_POSITIVE_HUMAN_IDP/);
  assert.match(workflow, /\.idp\.source == "ACCESS_POLICY_POSITIVE_HUMAN_IDP"/);
  assert.match(workflow, /ACCESS_ISSUER: https:\/\/super-salad-2357\.cloudflareaccess\.com/);
  assert.match(workflow, /\/cdn-cgi\/access\/certs/);
  assert.match(workflow, /\/access\/apps/);
  assert.match(workflow, /\.event == "workflow_dispatch" or \.event == "issue_comment"/);
  assert.doesNotMatch(workflow, /\/access\/identity_providers/);
  assert.doesNotMatch(workflow, /\/access\/organizations/);
});
