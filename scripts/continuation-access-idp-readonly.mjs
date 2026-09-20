#!/usr/bin/env node
import { readFileSync } from "node:fs";

export const CONTINUATION_ACCESS_IDP_EVIDENCE_SOURCE = "ACCESS_IDENTITY_PROVIDERS_API";
export const CONTINUATION_ACCESS_IDP_MAX_COUNT = 32;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTITY_PROVIDER_TYPES = new Set([
  "onetimepin",
  "azureAD",
  "saml",
  "centrify",
  "facebook",
  "github",
  "google-apps",
  "google",
  "linkedin",
  "oidc",
  "okta",
  "onelogin",
  "pingone",
  "yandex",
  "cloudflare",
]);

export class ContinuationAccessIdentityProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "ContinuationAccessIdentityProviderError";
    this.code = code;
  }
}

function fail(code) {
  throw new ContinuationAccessIdentityProviderError(code);
}

function resultArray(document) {
  if (Array.isArray(document)) return document;
  if (document?.success === true && Array.isArray(document.result)) return document.result;
  fail("ACCESS_IDP_INVENTORY_RESPONSE_INVALID");
}

function assertUuid(value, code) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(code);
  return value;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function sanitizeName(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    fail("ACCESS_IDP_NAME_INVALID");
  }
  return value;
}

function sanitizeType(value) {
  if (typeof value !== "string" || !IDENTITY_PROVIDER_TYPES.has(value)) {
    fail("ACCESS_IDP_TYPE_INVALID");
  }
  return value;
}

function sanitizeReadOnly(provider) {
  if (!Object.hasOwn(provider, "read_only")) return null;
  if (typeof provider.read_only !== "boolean") fail("ACCESS_IDP_READ_ONLY_INVALID");
  return provider.read_only;
}

function sanitizeProvider(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    fail("ACCESS_IDP_RECORD_INVALID");
  }
  return {
    id: assertUuid(provider.id, "ACCESS_IDP_ID_INVALID"),
    name: sanitizeName(provider.name),
    type: sanitizeType(provider.type),
    readOnly: sanitizeReadOnly(provider),
  };
}

export function sanitizeIdentityProviderInventory(document) {
  const providers = resultArray(document);
  if (providers.length > CONTINUATION_ACCESS_IDP_MAX_COUNT) fail("ACCESS_IDP_INVENTORY_UNBOUNDED");

  const seenIds = new Set();
  const sanitized = providers.map((provider) => {
    const safe = sanitizeProvider(provider);
    if (seenIds.has(safe.id)) fail("ACCESS_IDP_DUPLICATE_ID");
    seenIds.add(safe.id);
    return safe;
  });

  return sanitized.sort((left, right) =>
    `${left.type}\u0000${left.name}\u0000${left.id}`.localeCompare(`${right.type}\u0000${right.name}\u0000${right.id}`),
  );
}

export function verifyIdentityProviderSelection(document, expectedId) {
  const selectedId = assertUuid(expectedId, "ACCESS_IDP_EXPECTED_ID_INVALID");
  const providers = sanitizeIdentityProviderInventory(document);
  const matches = providers.filter((provider) => provider.id === selectedId);
  if (matches.length !== 1) fail("ACCESS_IDP_SELECTED_NOT_FOUND");
  return {
    status: "PASS",
    source: CONTINUATION_ACCESS_IDP_EVIDENCE_SOURCE,
    ...matches[0],
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
  if (command === "catalog") {
    if (args.length !== 1) fail("CATALOG_ARGUMENTS_INVALID");
    const providers = sanitizeIdentityProviderInventory(readJson(args[0]));
    process.stdout.write(`${JSON.stringify({
      status: "PASS",
      source: CONTINUATION_ACCESS_IDP_EVIDENCE_SOURCE,
      count: providers.length,
      identityProviders: providers,
    })}\n`);
    return;
  }

  if (command === "verify") {
    if (args.length !== 2) fail("VERIFY_ARGUMENTS_INVALID");
    process.stdout.write(`${JSON.stringify(verifyIdentityProviderSelection(readJson(args[0]), args[1]))}\n`);
    return;
  }

  fail(command ? "COMMAND_UNSUPPORTED" : "COMMAND_MISSING");
}

function reportError(error) {
  const code = error instanceof ContinuationAccessIdentityProviderError ? error.code : "UNEXPECTED_ERROR";
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
