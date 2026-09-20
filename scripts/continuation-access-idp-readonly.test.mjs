import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTINUATION_ACCESS_IDP_EVIDENCE_SOURCE,
  CONTINUATION_ACCESS_IDP_MAX_COUNT,
  ContinuationAccessIdentityProviderError,
  sanitizeIdentityProviderInventory,
  verifyIdentityProviderSelection,
} from "./continuation-access-idp-readonly.mjs";

const IDP_A = "11111111-1111-4111-8111-111111111111";
const IDP_B = "22222222-2222-4222-8222-222222222222";

function provider(overrides = {}) {
  return {
    id: IDP_A,
    name: "Owner login",
    type: "google",
    read_only: false,
    config: {
      client_id: "must-not-escape",
      client_secret: "must-never-escape",
      nested: { private: true },
    },
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof ContinuationAccessIdentityProviderError && error.code === code,
  );
}

test("catalog projects only public-safe IdP fields and is deterministic", () => {
  const input = {
    success: true,
    result: [
      provider({ id: IDP_B, name: "SAML login", type: "saml", read_only: true }),
      provider(),
    ],
  };
  const result = sanitizeIdentityProviderInventory(input);
  assert.deepEqual(result, [
    { id: IDP_A, name: "Owner login", type: "google", readOnly: false },
    { id: IDP_B, name: "SAML login", type: "saml", readOnly: true },
  ]);
  assert.equal(JSON.stringify(result).includes("client_secret"), false);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  assert.equal(JSON.stringify(result).includes("config"), false);
});

test("missing read_only is represented as unknown rather than guessed", () => {
  const withoutReadOnly = provider();
  delete withoutReadOnly.read_only;
  assert.deepEqual(sanitizeIdentityProviderInventory([withoutReadOnly]), [
    { id: IDP_A, name: "Owner login", type: "google", readOnly: null },
  ]);
});

test("catalog fails closed on malformed or ambiguous provider evidence", () => {
  expectCode(() => sanitizeIdentityProviderInventory({ success: false, result: [] }), "ACCESS_IDP_INVENTORY_RESPONSE_INVALID");
  expectCode(() => sanitizeIdentityProviderInventory([provider({ id: "not-a-uuid" })]), "ACCESS_IDP_ID_INVALID");
  expectCode(() => sanitizeIdentityProviderInventory([provider({ name: " owner " })]), "ACCESS_IDP_NAME_INVALID");
  expectCode(() => sanitizeIdentityProviderInventory([provider({ name: "bad\nname" })]), "ACCESS_IDP_NAME_INVALID");
  expectCode(() => sanitizeIdentityProviderInventory([provider({ type: "future-unknown-provider" })]), "ACCESS_IDP_TYPE_INVALID");
  expectCode(() => sanitizeIdentityProviderInventory([provider({ read_only: "false" })]), "ACCESS_IDP_READ_ONLY_INVALID");
  expectCode(
    () => sanitizeIdentityProviderInventory([provider(), provider({ name: "duplicate" })]),
    "ACCESS_IDP_DUPLICATE_ID",
  );
  expectCode(
    () => sanitizeIdentityProviderInventory(Array.from({ length: CONTINUATION_ACCESS_IDP_MAX_COUNT + 1 }, (_, index) => provider({
      id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      name: `Provider ${index + 1}`,
    }))),
    "ACCESS_IDP_INVENTORY_UNBOUNDED",
  );
});

test("exact selection accepts one observed UUID and rejects absent selection", () => {
  const input = [provider(), provider({ id: IDP_B, name: "GitHub login", type: "github" })];
  assert.deepEqual(verifyIdentityProviderSelection(input, IDP_B), {
    status: "PASS",
    source: CONTINUATION_ACCESS_IDP_EVIDENCE_SOURCE,
    id: IDP_B,
    name: "GitHub login",
    type: "github",
    readOnly: false,
  });
  expectCode(() => verifyIdentityProviderSelection(input, "33333333-3333-4333-8333-333333333333"), "ACCESS_IDP_SELECTED_NOT_FOUND");
  expectCode(() => verifyIdentityProviderSelection(input, "BAD"), "ACCESS_IDP_EXPECTED_ID_INVALID");
});

test("workflow is owner-only GET-only and never exposes raw IdP configuration", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/continuation-access-idp-readonly.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /github\.event\.issue\.number == 278/);
  assert.match(workflow, /github\.event\.comment\.user\.id == 277435981/);
  assert.match(workflow, /\/continuation-access-idp-catalog/);
  assert.match(workflow, /\/continuation-access-idp-verify:/);
  assert.match(workflow, /CLOUDFLARE_ACCESS_IDP_READ_TOKEN/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_ACCESS_WRITE_TOKEN/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_ACCESS_READ_TOKEN/);
  assert.match(workflow, /\/access\/identity_providers\?per_page=1000&page=1/);
  assert.match(workflow, /ACCESS_API_METHOD=GET_ONLY/);
  assert.match(workflow, /PRODUCTION_MUTATIONS=0/);
  assert.match(workflow, /IDP_CATALOG_JSON=/);
  assert.doesNotMatch(workflow, /cat\s+[^\n]*idps\.json/);
  assert.doesNotMatch(workflow, /jq\s+[^\n]*idps\.json/);
  assert.doesNotMatch(workflow, /curl[^\n]*\s-X\s+(POST|PUT|PATCH|DELETE)\b/i);
});

test("CI runs the focused IdP read-only contract test", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /node --test scripts\/continuation-access-idp-readonly\.test\.mjs/);
});
