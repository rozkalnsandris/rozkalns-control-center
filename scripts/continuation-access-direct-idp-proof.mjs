#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
  CONTINUATION_ACCESS_IDP_REFERENCE_URI,
  ContinuationAccessProvisioningError,
  assertContinuationAccessIssuer,
  assertExactContinuationAccessApplication,
  assertExactContinuationAccessPolicy,
  classifyExactIdentityProviderReference,
  continuationAccessApplicationConflicts,
  nonTargetAccessInventoryDigest,
} from "./continuation-access-provisioning.mjs";
import {
  CONTINUATION_ACCESS_IDP_EVIDENCE_SOURCE,
  ContinuationAccessIdentityProviderError,
  verifyIdentityProviderSelection,
} from "./continuation-access-idp-readonly.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ContinuationAccessDirectIdpProofError extends Error {
  constructor(code) {
    super(code);
    this.name = "ContinuationAccessDirectIdpProofError";
    this.code = code;
  }
}

function fail(code) {
  throw new ContinuationAccessDirectIdpProofError(code);
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

function assertReferenceConstraint(referenceAppDocument, expectedIdpId) {
  const evidence = classifyExactIdentityProviderReference(referenceAppDocument);
  if (evidence.classification === "MULTIPLE") fail("ACCESS_IDP_REFERENCE_ALLOWED_IDPS_MULTIPLE");
  if (evidence.classification === "ONE" && evidence.id !== expectedIdpId) {
    fail("ACCESS_IDP_REFERENCE_APP_MISMATCH");
  }
  return evidence.classification;
}

function directIdpEvidence(idpInventory, expectedIdpId, referenceAppDocument) {
  const selected = verifyIdentityProviderSelection(idpInventory, expectedIdpId);
  const referenceConstraint = assertReferenceConstraint(referenceAppDocument, expectedIdpId);
  return {
    id: selected.id,
    name: selected.name,
    type: selected.type,
    readOnly: selected.readOnly,
    source: CONTINUATION_ACCESS_IDP_EVIDENCE_SOURCE,
    referenceAppId: CONTINUATION_ACCESS_IDP_REFERENCE_APP_ID,
    referenceUri: CONTINUATION_ACCESS_IDP_REFERENCE_URI,
    referenceConstraint,
  };
}

export function evaluateContinuationAccessDirectIdpPreflight({
  apps,
  policiesByApp,
  idpInventory,
  expectedIdpId,
  issuer,
  referenceApp,
}) {
  const conflicts = continuationAccessApplicationConflicts(apps);
  if (conflicts.length !== 0) fail("ACCESS_CONTINUATION_TARGET_CONFLICT");
  const idp = directIdpEvidence(idpInventory, expectedIdpId, referenceApp);
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

export function evaluateContinuationAccessDirectIdpPostflight({
  apps,
  policiesByApp,
  idpInventory,
  createdAppId,
  expectedIdpId,
  ownerEmail,
  issuer,
  expectedNonTargetDigest,
  referenceApp,
  createdAppResponse,
}) {
  if (!UUID_PATTERN.test(createdAppId)) fail("ACCESS_CREATED_APP_ID_INVALID");
  if (!SHA256_PATTERN.test(expectedNonTargetDigest)) fail("ACCESS_EXPECTED_DIGEST_INVALID");
  const reviewedIssuer = assertContinuationAccessIssuer(issuer);
  const idp = directIdpEvidence(idpInventory, expectedIdpId, referenceApp);
  const appList = resultArray(apps, "ACCESS_APP_INVENTORY_INVALID");
  const conflicts = continuationAccessApplicationConflicts(appList);
  if (conflicts.length !== 1 || conflicts[0].id !== createdAppId) fail("ACCESS_CREATED_APP_NOT_UNIQUE");
  const app = appList.find((candidate) => candidate?.id === createdAppId);
  const exactApp = assertExactContinuationAccessApplication(app, createdAppId, expectedIdpId);
  const responseApp = resultObject(createdAppResponse, "ACCESS_CREATED_APP_RESPONSE_INVALID");
  if (responseApp?.id !== createdAppId || responseApp?.aud !== exactApp.aud) {
    fail("ACCESS_CREATED_APP_RESPONSE_CHANGED");
  }
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

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "preflight") {
    if (args.length !== 6) fail("PREFLIGHT_ARGUMENTS_INVALID");
    const [appsPath, policiesPath, idpsPath, expectedIdpId, issuer, referenceAppPath] = args;
    const result = evaluateContinuationAccessDirectIdpPreflight({
      apps: readJson(appsPath),
      policiesByApp: readJson(policiesPath),
      idpInventory: readJson(idpsPath),
      expectedIdpId,
      issuer,
      referenceApp: readJson(referenceAppPath),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "postflight") {
    if (args.length !== 9) fail("POSTFLIGHT_ARGUMENTS_INVALID");
    const [appsPath, policiesPath, idpsPath, createdAppId, expectedIdpId, issuer, expectedDigest, referenceAppPath, createdAppResponsePath] = args;
    const result = evaluateContinuationAccessDirectIdpPostflight({
      apps: readJson(appsPath),
      policiesByApp: readJson(policiesPath),
      idpInventory: readJson(idpsPath),
      createdAppId,
      expectedIdpId,
      ownerEmail: process.env.CONTROL_CONTINUATION_OWNER_EMAIL ?? "",
      issuer,
      expectedNonTargetDigest: expectedDigest,
      referenceApp: readJson(referenceAppPath),
      createdAppResponse: readJson(createdAppResponsePath),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  fail(command ? "COMMAND_UNSUPPORTED" : "COMMAND_MISSING");
}

function reportError(error) {
  const code =
    error instanceof ContinuationAccessDirectIdpProofError ||
    error instanceof ContinuationAccessProvisioningError ||
    error instanceof ContinuationAccessIdentityProviderError
      ? error.code
      : "UNEXPECTED_ERROR";
  process.stderr.write(`${JSON.stringify({ status: "STOP", code })}\n`);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    reportError(error);
  }
}
