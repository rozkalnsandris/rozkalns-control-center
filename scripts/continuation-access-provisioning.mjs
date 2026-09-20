#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { accessApplicationPublicUris } from "./cloudflare-access-app-identity.mjs";

export const CONTINUATION_ACCESS_ACCOUNT_ID = "70e29dbca0e8363358659102d2b74178";
export const CONTINUATION_ACCESS_APP_NAME = "Rozkalns Control owner continuation";
export const CONTINUATION_ACCESS_POLICY_NAME = "rozkalns-control-owner-continuation";
export const CONTINUATION_ACCESS_DESTINATIONS = Object.freeze([
  "control.rozkalns.net/api/control/continuation",
  "control.rozkalns.net/api/control/continuation/preflight",
]);
export const CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID = "235c0666-9e1b-45a2-a7a2-63433c8a2247";
export const CONTINUATION_ACCESS_IDP_REFERENCE_URI = "*.rozkalns.net";
export const CONTINUATION_ACCESS_IDP_REFERENCE_SOURCE = "ACCESS_POLICY_POSITIVE_HUMAN_IDP";
export const CONTINUATION_ACCESS_ISSUER = "https://super-salad-2357.cloudflareaccess.com";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ContinuationAccessProvisioningError extends Error {
  constructor(code) {
    super(code);
    this.name = "ContinuationAccessProvisioningError";
    this.code = code;
  }
}

function fail(code) {
  throw new ContinuationAccessProvisioningError(code);
}

function assertUuid(value, code) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(code);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeUri(value) {
  if (typeof value !== "string") return "";
  let normalized = value.trim().replace(/^https?:\/\//i, "");
  while (normalized.endsWith("/") && normalized !== "/") normalized = normalized.slice(0, -1);
  return normalized;
}

function resultArray(document, code) {
  if (Array.isArray(document)) return document;
  if (document?.success === true && Array.isArray(document.result)) return document.result;
  fail(code);
}

function resultObject(document, code) {
  if (isObject(document) && !Object.hasOwn(document, "success")) return document;
  if (document?.success === true && isObject(document.result)) return document.result;
  fail(code);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalAppForDigest(app) {
  const copy = structuredClone(app);
  if (copy && typeof copy === "object") delete copy.policies;
  return canonicalize(copy);
}

function policySortKey(policy) {
  if (typeof policy?.id === "string") return `0:${policy.id}`;
  return `1:${JSON.stringify(canonicalize(policy))}`;
}

function canonicalPoliciesForDigest(policies) {
  if (!Array.isArray(policies)) fail("ACCESS_POLICY_INVENTORY_INVALID");
  return [...policies]
    .sort((a, b) => policySortKey(a).localeCompare(policySortKey(b)))
    .map(canonicalize);
}

function assertReferenceApplicationShape(app) {
  if (app?.id !== CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID) fail("ACCESS_IDP_REFERENCE_APP_ID_CHANGED");
  if (app?.type !== "self_hosted") fail("ACCESS_IDP_REFERENCE_APP_TYPE_INVALID");
  const uris = [...new Set(accessApplicationPublicUris(app).map(normalizeUri).filter(Boolean))].sort();
  if (JSON.stringify(uris) !== JSON.stringify([CONTINUATION_ACCESS_IDP_REFERENCE_URI])) {
    fail("ACCESS_IDP_REFERENCE_APP_DESTINATION_INVALID");
  }
  return app;
}

function canonicalReferenceApplicationFromInventory(appsDocument) {
  const apps = resultArray(appsDocument, "ACCESS_APP_INVENTORY_INVALID");
  if (apps.length > 1000) fail("ACCESS_APP_INVENTORY_UNBOUNDED");
  const matches = apps.filter((app) => app?.id === CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID);
  if (matches.length !== 1) fail("ACCESS_IDP_REFERENCE_APP_NOT_EXACT");
  return assertReferenceApplicationShape(matches[0]);
}

function containsIdentityProviderIdField(value) {
  if (Array.isArray(value)) return value.some(containsIdentityProviderIdField);
  if (!isObject(value)) return false;
  if (Object.hasOwn(value, "identity_provider_id")) return true;
  return Object.values(value).some(containsIdentityProviderIdField);
}

function identityProviderIdFromPositiveRule(rule) {
  if (!isObject(rule)) fail("ACCESS_IDP_POLICY_RULE_INVALID");
  const entries = Object.entries(rule);
  const identityLooking = entries.some(
    ([selectorName, selector]) => selectorName === "login_method" || containsIdentityProviderIdField(selector),
  );
  if (entries.length !== 1) {
    if (identityLooking) fail("ACCESS_IDP_POLICY_SELECTOR_SHAPE_INVALID");
    return null;
  }

  const [selectorName, selector] = entries[0];
  if (selectorName === "login_method") {
    if (!isObject(selector) || !Object.hasOwn(selector, "id")) {
      fail("ACCESS_IDP_POLICY_LOGIN_METHOD_INVALID");
    }
    return assertUuid(selector.id, "ACCESS_IDP_POLICY_ID_INVALID");
  }

  if (isObject(selector) && Object.hasOwn(selector, "identity_provider_id")) {
    return assertUuid(selector.identity_provider_id, "ACCESS_IDP_POLICY_ID_INVALID");
  }

  if (containsIdentityProviderIdField(selector)) fail("ACCESS_IDP_POLICY_SELECTOR_UNSUPPORTED");
  return null;
}

function referencePoliciesFromMap(policiesByApp) {
  if (!isObject(policiesByApp)) fail("ACCESS_POLICY_MAP_INVALID");
  if (!Object.hasOwn(policiesByApp, CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID)) {
    fail("ACCESS_IDP_REFERENCE_POLICY_MAP_INCOMPLETE");
  }
  const policies = policiesByApp[CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID];
  if (!Array.isArray(policies)) fail("ACCESS_IDP_REFERENCE_POLICY_INVENTORY_INVALID");
  return policies;
}

export function assertContinuationAccessIssuer(issuer) {
  if (issuer !== CONTINUATION_ACCESS_ISSUER) fail("ACCESS_ISSUER_NOT_REVIEWED");
  return issuer;
}

export function classifyExactIdentityProviderReference(exactAppDocument) {
  const app = assertReferenceApplicationShape(
    resultObject(exactAppDocument, "ACCESS_IDP_REFERENCE_EXACT_APP_RESPONSE_INVALID"),
  );
  if (!Object.hasOwn(app, "allowed_idps")) return { classification: "ABSENT", count: 0 };
  if (!Array.isArray(app.allowed_idps)) fail("ACCESS_IDP_REFERENCE_ALLOWED_IDPS_INVALID");
  if (app.allowed_idps.length === 0) return { classification: "EMPTY", count: 0 };
  if (app.allowed_idps.length > 1) return { classification: "MULTIPLE", count: app.allowed_idps.length };
  return {
    classification: "ONE",
    count: 1,
    id: assertUuid(app.allowed_idps[0], "ACCESS_IDP_REFERENCE_ID_INVALID"),
  };
}

export function classifyPolicyIdentityProviderReference(policiesDocument) {
  const policies = resultArray(policiesDocument, "ACCESS_IDP_REFERENCE_POLICY_INVENTORY_INVALID");
  if (policies.length > 100) fail("ACCESS_IDP_REFERENCE_POLICY_COUNT_UNBOUNDED");
  const ids = new Set();
  let evidenceRuleCount = 0;

  for (const policy of policies) {
    if (!isObject(policy)) fail("ACCESS_IDP_REFERENCE_POLICY_INVALID");
    if (policy.decision !== "allow") continue;
    for (const field of ["include", "require"]) {
      if (!Object.hasOwn(policy, field)) continue;
      const rules = policy[field];
      if (!Array.isArray(rules)) fail("ACCESS_IDP_POLICY_RULES_INVALID");
      for (const rule of rules) {
        const id = identityProviderIdFromPositiveRule(rule);
        if (!id) continue;
        ids.add(id);
        evidenceRuleCount += 1;
      }
    }
  }

  const distinctIds = [...ids].sort();
  if (distinctIds.length === 0) {
    return { classification: "ZERO", count: 0, evidenceRuleCount: 0 };
  }
  if (distinctIds.length > 1) {
    return { classification: "MULTIPLE", count: distinctIds.length, evidenceRuleCount };
  }
  return {
    classification: "ONE",
    count: 1,
    evidenceRuleCount,
    id: distinctIds[0],
    source: CONTINUATION_ACCESS_IDP_REFERENCE_SOURCE,
  };
}

export function canonicalIdentityProviderReference(appsDocument, policiesByApp, exactAppDocument = undefined) {
  const inventoryApp = canonicalReferenceApplicationFromInventory(appsDocument);
  const referenceApp = exactAppDocument === undefined
    ? inventoryApp
    : assertReferenceApplicationShape(
        resultObject(exactAppDocument, "ACCESS_IDP_REFERENCE_EXACT_APP_RESPONSE_INVALID"),
      );
  const appEvidence = classifyExactIdentityProviderReference(referenceApp);
  if (appEvidence.classification === "MULTIPLE") fail("ACCESS_IDP_REFERENCE_ALLOWED_IDPS_MULTIPLE");

  const policyEvidence = classifyPolicyIdentityProviderReference(referencePoliciesFromMap(policiesByApp));
  if (policyEvidence.classification === "ZERO") fail("ACCESS_IDP_REFERENCE_POLICY_ZERO");
  if (policyEvidence.classification === "MULTIPLE") fail("ACCESS_IDP_REFERENCE_POLICY_MULTIPLE");
  if (policyEvidence.classification !== "ONE") fail("ACCESS_IDP_REFERENCE_POLICY_NOT_EXACT");
  if (appEvidence.classification === "ONE" && appEvidence.id !== policyEvidence.id) {
    fail("ACCESS_IDP_REFERENCE_APP_POLICY_MISMATCH");
  }

  return {
    id: policyEvidence.id,
    referenceAppId: CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
    referenceUri: CONTINUATION_ACCESS_IDP_REFERENCE_URI,
    source: CONTINUATION_ACCESS_IDP_REFERENCE_SOURCE,
  };
}

export function assertSelectedIdentityProviderReference(
  appsDocument,
  policiesByApp,
  expectedId,
  exactAppDocument = undefined,
) {
  assertUuid(expectedId, "ACCESS_IDP_ID_INVALID");
  const reference = canonicalIdentityProviderReference(appsDocument, policiesByApp, exactAppDocument);
  if (reference.id !== expectedId) fail("ACCESS_IDP_REFERENCE_CHANGED");
  return reference;
}

export function continuationAccessApplicationConflicts(appsDocument) {
  const apps = resultArray(appsDocument, "ACCESS_APP_INVENTORY_INVALID");
  if (apps.length > 1000) fail("ACCESS_APP_INVENTORY_UNBOUNDED");
  const targets = new Set(CONTINUATION_ACCESS_DESTINATIONS.map(normalizeUri));
  const conflicts = [];

  for (const app of apps) {
    const appTargets = accessApplicationPublicUris(app).map(normalizeUri).filter((uri) => targets.has(uri));
    const reservedName = app?.name === CONTINUATION_ACCESS_APP_NAME;
    if (!reservedName && appTargets.length === 0) continue;
    conflicts.push({
      id: typeof app?.id === "string" ? app.id : "",
      name: typeof app?.name === "string" ? app.name : "",
      exactDestinations: [...new Set(appTargets)].sort(),
      reservedName,
    });
  }

  return conflicts.sort((a, b) => `${a.id}:${a.name}`.localeCompare(`${b.id}:${b.name}`));
}

export function nonTargetAccessInventoryDigest(appsDocument, policiesByApp, excludeAppId = "") {
  const apps = resultArray(appsDocument, "ACCESS_APP_INVENTORY_INVALID");
  if (!isObject(policiesByApp)) fail("ACCESS_POLICY_MAP_INVALID");
  if (excludeAppId !== "") assertUuid(excludeAppId, "ACCESS_EXCLUDED_APP_ID_INVALID");

  const records = [];
  for (const app of apps) {
    const id = assertUuid(app?.id, "ACCESS_APP_ID_INVALID");
    if (id === excludeAppId) continue;
    if (!Object.hasOwn(policiesByApp, id)) fail("ACCESS_POLICY_MAP_INCOMPLETE");
    records.push({
      id,
      app: canonicalAppForDigest(app),
      policies: canonicalPoliciesForDigest(policiesByApp[id]),
    });
  }

  records.sort((a, b) => a.id.localeCompare(b.id));
  const canonical = JSON.stringify(canonicalize(records));
  return createHash("sha256").update(canonical).digest("hex");
}

function assertOwnerEmail(ownerEmail) {
  if (typeof ownerEmail !== "string" || ownerEmail.length > 254 || !EMAIL_PATTERN.test(ownerEmail)) {
    fail("ACCESS_OWNER_EMAIL_INVALID");
  }
  return ownerEmail;
}

export function buildContinuationAccessApplicationPayload(identityProviderId, ownerEmail) {
  assertUuid(identityProviderId, "ACCESS_IDP_ID_INVALID");
  const exactOwnerEmail = assertOwnerEmail(ownerEmail);
  return {
    name: CONTINUATION_ACCESS_APP_NAME,
    type: "self_hosted",
    domain: CONTINUATION_ACCESS_DESTINATIONS[0],
    destinations: CONTINUATION_ACCESS_DESTINATIONS.map((uri) => ({ type: "public", uri })),
    allowed_idps: [identityProviderId],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    allow_authenticate_via_warp: false,
    policies: [
      {
        name: CONTINUATION_ACCESS_POLICY_NAME,
        decision: "allow",
        precedence: 1,
        include: [{ email: { email: exactOwnerEmail } }],
      },
    ],
  };
}

export function assertExactContinuationAccessApplication(appDocument, expectedId, expectedIdpId) {
  const app = resultObject(appDocument, "ACCESS_CREATED_APP_RESPONSE_INVALID");
  assertUuid(expectedId, "ACCESS_CREATED_APP_ID_INVALID");
  assertUuid(expectedIdpId, "ACCESS_IDP_ID_INVALID");
  if (app?.id !== expectedId) fail("ACCESS_CREATED_APP_ID_CHANGED");
  if (app?.name !== CONTINUATION_ACCESS_APP_NAME || app?.type !== "self_hosted") {
    fail("ACCESS_CREATED_APP_SHAPE_INVALID");
  }
  if (normalizeUri(app?.domain) !== CONTINUATION_ACCESS_DESTINATIONS[0]) {
    fail("ACCESS_CREATED_APP_DOMAIN_INVALID");
  }
  const actualDestinations = accessApplicationPublicUris(app).map(normalizeUri).sort();
  const expectedDestinations = [...CONTINUATION_ACCESS_DESTINATIONS].sort();
  if (JSON.stringify(actualDestinations) !== JSON.stringify(expectedDestinations)) {
    fail("ACCESS_CREATED_APP_DESTINATIONS_INVALID");
  }
  if (!Array.isArray(app?.allowed_idps) || app.allowed_idps.length !== 1 || app.allowed_idps[0] !== expectedIdpId) {
    fail("ACCESS_CREATED_APP_IDP_INVALID");
  }
  if (app?.auto_redirect_to_identity !== true || app?.app_launcher_visible !== false || app?.allow_authenticate_via_warp !== false) {
    fail("ACCESS_CREATED_APP_AUTH_SETTINGS_INVALID");
  }
  if (typeof app?.aud !== "string" || !AUDIENCE_PATTERN.test(app.aud)) {
    fail("ACCESS_CREATED_APP_AUDIENCE_INVALID");
  }
  return app;
}

export function assertExactContinuationAccessPolicy(policy, ownerEmail) {
  const exactOwnerEmail = assertOwnerEmail(ownerEmail);
  if (!isObject(policy)) fail("ACCESS_CREATED_POLICY_INVALID");
  assertUuid(policy?.id, "ACCESS_CREATED_POLICY_ID_INVALID");
  if (policy?.name !== CONTINUATION_ACCESS_POLICY_NAME || policy?.decision !== "allow" || Number(policy?.precedence) !== 1) {
    fail("ACCESS_CREATED_POLICY_SHAPE_INVALID");
  }
  const include = policy?.include;
  if (
    !Array.isArray(include) ||
    include.length !== 1 ||
    include[0]?.email?.email !== exactOwnerEmail ||
    Object.keys(include[0] ?? {}).length !== 1
  ) {
    fail("ACCESS_CREATED_POLICY_OWNER_SELECTOR_INVALID");
  }
  if ((Array.isArray(policy?.exclude) && policy.exclude.length !== 0) || (Array.isArray(policy?.require) && policy.require.length !== 0)) {
    fail("ACCESS_CREATED_POLICY_EXTRA_RULES_INVALID");
  }
  return policy;
}

export function evaluateContinuationAccessPreflight({ apps, policiesByApp, expectedIdpId, issuer, referenceApp }) {
  const conflicts = continuationAccessApplicationConflicts(apps);
  if (conflicts.length !== 0) fail("ACCESS_CONTINUATION_TARGET_CONFLICT");
  const idp = assertSelectedIdentityProviderReference(apps, policiesByApp, expectedIdpId, referenceApp);
  const reviewedIssuer = assertContinuationAccessIssuer(issuer);
  const nonTargetDigest = nonTargetAccessInventoryDigest(apps, policiesByApp);
  return {
    status: "PASS",
    conflictCount: 0,
    idp,
    issuer: reviewedIssuer,
    nonTargetDigest,
  };
}

export function evaluateContinuationAccessPostflight({
  apps,
  policiesByApp,
  createdAppId,
  expectedIdpId,
  ownerEmail,
  issuer,
  expectedNonTargetDigest,
  referenceApp,
}) {
  assertUuid(createdAppId, "ACCESS_CREATED_APP_ID_INVALID");
  if (!SHA256_PATTERN.test(expectedNonTargetDigest)) fail("ACCESS_EXPECTED_DIGEST_INVALID");
  const reviewedIssuer = assertContinuationAccessIssuer(issuer);
  const appList = resultArray(apps, "ACCESS_APP_INVENTORY_INVALID");
  const idp = assertSelectedIdentityProviderReference(appList, policiesByApp, expectedIdpId, referenceApp);
  const conflicts = continuationAccessApplicationConflicts(appList);
  if (conflicts.length !== 1 || conflicts[0].id !== createdAppId) fail("ACCESS_CREATED_APP_NOT_UNIQUE");
  const app = appList.find((candidate) => candidate?.id === createdAppId);
  const exactApp = assertExactContinuationAccessApplication(app, createdAppId, expectedIdpId);
  const policies = policiesByApp?.[createdAppId];
  if (!Array.isArray(policies) || policies.length !== 1) fail("ACCESS_CREATED_POLICY_COUNT_INVALID");
  const policy = assertExactContinuationAccessPolicy(policies[0], ownerEmail);
  const actualNonTargetDigest = nonTargetAccessInventoryDigest(appList, policiesByApp, createdAppId);
  if (actualNonTargetDigest !== expectedNonTargetDigest) fail("ACCESS_NON_TARGET_DIGEST_CHANGED");
  return {
    status: "PASS",
    appId: createdAppId,
    audience: exactApp.aud,
    policyId: policy.id,
    idp,
    issuer: reviewedIssuer,
    nonTargetDigest: actualNonTargetDigest,
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("INPUT_JSON_INVALID");
  }
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function reviewedReadToken() {
  if ((process.env.CF_ACCOUNT_ID ?? "") !== CONTINUATION_ACCESS_ACCOUNT_ID) {
    fail("ACCESS_IDP_REFERENCE_ACCOUNT_ID_NOT_REVIEWED");
  }
  const token = process.env.CLOUDFLARE_ACCESS_READ_TOKEN ?? "";
  if (token.length === 0) fail("ACCESS_IDP_REFERENCE_READ_TOKEN_MISSING");
  return token;
}

async function fetchExactReferenceAppDocument() {
  const token = reviewedReadToken();
  const url = `https://api.cloudflare.com/client/v4/accounts/${CONTINUATION_ACCESS_ACCOUNT_ID}/access/apps/${CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID}`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("ACCESS_IDP_REFERENCE_EXACT_APP_GET_FAILED");
  }
  if (!response.ok) fail("ACCESS_IDP_REFERENCE_EXACT_APP_GET_FAILED");
  let document;
  try {
    document = await response.json();
  } catch {
    fail("ACCESS_IDP_REFERENCE_EXACT_APP_RESPONSE_INVALID");
  }
  if (document?.success !== true) fail("ACCESS_IDP_REFERENCE_EXACT_APP_RESPONSE_INVALID");
  return document;
}

async function fetchExactReferencePolicies() {
  const token = reviewedReadToken();
  const collected = [];
  for (let page = 1; page <= 2; page += 1) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CONTINUATION_ACCESS_ACCOUNT_ID}/access/apps/${CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID}/policies?per_page=100&page=${page}`;
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      fail("ACCESS_IDP_REFERENCE_POLICY_GET_FAILED");
    }
    if (!response.ok) fail("ACCESS_IDP_REFERENCE_POLICY_GET_FAILED");
    let document;
    try {
      document = await response.json();
    } catch {
      fail("ACCESS_IDP_REFERENCE_POLICY_RESPONSE_INVALID");
    }
    if (document?.success !== true || !Array.isArray(document.result)) {
      fail("ACCESS_IDP_REFERENCE_POLICY_RESPONSE_INVALID");
    }
    collected.push(...document.result);
    if (collected.length > 100) fail("ACCESS_IDP_REFERENCE_POLICY_COUNT_UNBOUNDED");
    if (document.result.length < 100) return collected;
  }
  fail("ACCESS_IDP_REFERENCE_POLICY_COUNT_UNBOUNDED");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) fail("COMMAND_MISSING");

  if (command === "reference-idp") {
    if (args.length !== 1) fail("REFERENCE_IDP_ARGUMENTS_INVALID");
    const [appsPath] = args;
    const exactReferenceApp = await fetchExactReferenceAppDocument();
    const exactReferencePolicies = await fetchExactReferencePolicies();
    const policiesByApp = { [CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID]: exactReferencePolicies };
    const result = canonicalIdentityProviderReference(readJson(appsPath), policiesByApp, exactReferenceApp);
    process.stdout.write(`${JSON.stringify({ status: "PASS", ...result })}\n`);
    return;
  }

  if (command === "preflight") {
    if (args.length !== 4) fail("PREFLIGHT_ARGUMENTS_INVALID");
    const [appsPath, policiesPath, expectedIdpId, issuer] = args;
    const policiesByApp = readJson(policiesPath);
    const exactReferenceApp = await fetchExactReferenceAppDocument();
    const result = evaluateContinuationAccessPreflight({
      apps: readJson(appsPath),
      policiesByApp,
      expectedIdpId,
      issuer,
      referenceApp: exactReferenceApp,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "payload") {
    if (args.length !== 2) fail("PAYLOAD_ARGUMENTS_INVALID");
    const [expectedIdpId, outputPath] = args;
    writePrivateJson(
      outputPath,
      buildContinuationAccessApplicationPayload(expectedIdpId, process.env.CONTROL_CONTINUATION_OWNER_EMAIL ?? ""),
    );
    process.stdout.write('{"status":"PASS","payload":"WRITTEN_PRIVATE"}\n');
    return;
  }

  if (command === "postflight") {
    if (args.length !== 7) fail("POSTFLIGHT_ARGUMENTS_INVALID");
    const [appsPath, policiesPath, createdAppId, expectedIdpId, issuer, expectedDigest, createdAppResponsePath] = args;
    const responseApp = resultObject(readJson(createdAppResponsePath), "ACCESS_CREATED_APP_RESPONSE_INVALID");
    if (responseApp?.id !== createdAppId) fail("ACCESS_CREATED_APP_RESPONSE_ID_CHANGED");
    const policiesByApp = readJson(policiesPath);
    const exactReferenceApp = await fetchExactReferenceAppDocument();
    const result = evaluateContinuationAccessPostflight({
      apps: readJson(appsPath),
      policiesByApp,
      createdAppId,
      expectedIdpId,
      ownerEmail: process.env.CONTROL_CONTINUATION_OWNER_EMAIL ?? "",
      issuer,
      expectedNonTargetDigest: expectedDigest,
      referenceApp: exactReferenceApp,
    });
    if (responseApp?.aud !== result.audience) fail("ACCESS_CREATED_APP_RESPONSE_AUDIENCE_CHANGED");
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  fail("COMMAND_UNSUPPORTED");
}

function reportError(error) {
  const code = error instanceof ContinuationAccessProvisioningError ? error.code : "UNEXPECTED_ERROR";
  process.stderr.write(`${JSON.stringify({ status: "STOP", code })}\n`);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(reportError);
}
