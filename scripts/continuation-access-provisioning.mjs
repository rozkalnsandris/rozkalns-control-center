#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { accessApplicationPublicUris } from "./cloudflare-access-app-identity.mjs";

export const CONTINUATION_ACCESS_APP_NAME = "Rozkalns Control owner continuation";
export const CONTINUATION_ACCESS_POLICY_NAME = "rozkalns-control-owner-continuation";
export const CONTINUATION_ACCESS_DESTINATIONS = Object.freeze([
  "control.rozkalns.net/api/control/continuation",
  "control.rozkalns.net/api/control/continuation/preflight",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCESS_DOMAIN_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.cloudflareaccess\.com$/;

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
  if (document && typeof document === "object" && !Array.isArray(document) && !Object.hasOwn(document, "success")) {
    return document;
  }
  if (document?.success === true && document.result && typeof document.result === "object" && !Array.isArray(document.result)) {
    return document.result;
  }
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

export function accessIssuerFromOrganization(organizationDocument) {
  const organization = resultObject(organizationDocument, "ACCESS_ORGANIZATION_INVALID");
  const authDomain = organization?.auth_domain;
  if (typeof authDomain !== "string" || !ACCESS_DOMAIN_PATTERN.test(authDomain)) {
    fail("ACCESS_ORGANIZATION_AUTH_DOMAIN_INVALID");
  }
  return `https://${authDomain.toLowerCase()}`;
}

export function assertSelectedIdentityProvider(identityProvidersDocument, expectedId) {
  assertUuid(expectedId, "ACCESS_IDP_ID_INVALID");
  const providers = resultArray(identityProvidersDocument, "ACCESS_IDP_INVENTORY_INVALID");
  if (providers.length > 1000) fail("ACCESS_IDP_INVENTORY_UNBOUNDED");
  const matches = providers.filter((provider) => provider?.id === expectedId);
  if (matches.length !== 1) fail("ACCESS_IDP_NOT_EXACT");
  const provider = matches[0];
  if (typeof provider?.name !== "string" || provider.name.length < 1 || provider.name.length > 200) {
    fail("ACCESS_IDP_NAME_INVALID");
  }
  if (typeof provider?.type !== "string" || provider.type.length < 1 || provider.type.length > 100) {
    fail("ACCESS_IDP_TYPE_INVALID");
  }
  return { id: expectedId, name: provider.name, type: provider.type };
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
  if (!policiesByApp || typeof policiesByApp !== "object" || Array.isArray(policiesByApp)) {
    fail("ACCESS_POLICY_MAP_INVALID");
  }
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
  if (!policy || typeof policy !== "object") fail("ACCESS_CREATED_POLICY_INVALID");
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

export function evaluateContinuationAccessPreflight({ apps, policiesByApp, identityProviders, expectedIdpId, organization }) {
  const conflicts = continuationAccessApplicationConflicts(apps);
  if (conflicts.length !== 0) fail("ACCESS_CONTINUATION_TARGET_CONFLICT");
  const idp = assertSelectedIdentityProvider(identityProviders, expectedIdpId);
  const issuer = accessIssuerFromOrganization(organization);
  const nonTargetDigest = nonTargetAccessInventoryDigest(apps, policiesByApp);
  return {
    status: "PASS",
    conflictCount: 0,
    idp,
    issuer,
    nonTargetDigest,
  };
}

export function evaluateContinuationAccessPostflight({
  apps,
  policiesByApp,
  createdAppId,
  expectedIdpId,
  ownerEmail,
  organization,
  expectedNonTargetDigest,
}) {
  assertUuid(createdAppId, "ACCESS_CREATED_APP_ID_INVALID");
  if (!SHA256_PATTERN.test(expectedNonTargetDigest)) fail("ACCESS_EXPECTED_DIGEST_INVALID");
  const appList = resultArray(apps, "ACCESS_APP_INVENTORY_INVALID");
  const conflicts = continuationAccessApplicationConflicts(appList);
  if (conflicts.length !== 1 || conflicts[0].id !== createdAppId) {
    fail("ACCESS_CREATED_APP_NOT_UNIQUE");
  }
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
    issuer: accessIssuerFromOrganization(organization),
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

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) fail("COMMAND_MISSING");

  if (command === "preflight") {
    if (args.length !== 5) fail("PREFLIGHT_ARGUMENTS_INVALID");
    const [appsPath, policiesPath, idpsPath, organizationPath, expectedIdpId] = args;
    const result = evaluateContinuationAccessPreflight({
      apps: readJson(appsPath),
      policiesByApp: readJson(policiesPath),
      identityProviders: readJson(idpsPath),
      expectedIdpId,
      organization: readJson(organizationPath),
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
    const [appsPath, policiesPath, createdAppId, expectedIdpId, organizationPath, expectedDigest, createdAppResponsePath] = args;
    const responseApp = resultObject(readJson(createdAppResponsePath), "ACCESS_CREATED_APP_RESPONSE_INVALID");
    if (responseApp?.id !== createdAppId) fail("ACCESS_CREATED_APP_RESPONSE_ID_CHANGED");
    const result = evaluateContinuationAccessPostflight({
      apps: readJson(appsPath),
      policiesByApp: readJson(policiesPath),
      createdAppId,
      expectedIdpId,
      ownerEmail: process.env.CONTROL_CONTINUATION_OWNER_EMAIL ?? "",
      organization: readJson(organizationPath),
      expectedNonTargetDigest: expectedDigest,
    });
    if (responseApp?.aud !== result.audience) fail("ACCESS_CREATED_APP_RESPONSE_AUDIENCE_CHANGED");
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  fail("COMMAND_UNSUPPORTED");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    const code = error instanceof ContinuationAccessProvisioningError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(`${JSON.stringify({ status: "STOP", code })}\n`);
    process.exitCode = 1;
  }
}
