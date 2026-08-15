import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const helperUrl = pathToFileURL(resolve("scripts/cloudflare-access-app-identity.mjs")).href;

function runHelper(body: string) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `import * as helper from ${JSON.stringify(helperUrl)};\n${body}`],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

function makeJwt(payload: object) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

test("reads the single application audience from an Access application token", () => {
  const token = makeJwt({ type: "app", aud: ["a".repeat(64)] });
  const result = runHelper(`console.log(helper.readAccessTokenApplicationAudience(${JSON.stringify(token)}));`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "a".repeat(64));
});

test("rejects malformed, non-app and ambiguous Access tokens", () => {
  const cases = [
    { token: "not-a-jwt", code: "ACCESS_TOKEN_INVALID" },
    { token: makeJwt({ type: "org", aud: ["audience"] }), code: "ACCESS_TOKEN_TYPE_INVALID" },
    { token: makeJwt({ type: "app", aud: [] }), code: "ACCESS_TOKEN_AUDIENCE_INVALID" },
    { token: makeJwt({ type: "app", aud: ["one", "two"] }), code: "ACCESS_TOKEN_AUDIENCE_INVALID" },
  ];

  for (const entry of cases) {
    const result = runHelper(`
      try {
        helper.readAccessTokenApplicationAudience(${JSON.stringify(entry.token)});
        process.exitCode = 40;
      } catch (error) {
        console.log(error.code);
      }
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), entry.code);
  }
});

test("identifies exactly one parent self-hosted application by token audience", () => {
  const apps = [
    { id: "11111111-1111-4111-8111-111111111111", type: "self_hosted", aud: "target" },
    { id: "22222222-2222-4222-8222-222222222222", type: "self_hosted", aud: "other" },
    { id: "33333333-3333-4333-8333-333333333333", type: "saas", aud: "target" },
  ];
  const result = runHelper(`
    const app = helper.exactParentAccessApplication(${JSON.stringify(apps)}, "target");
    console.log(app.id);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "11111111-1111-4111-8111-111111111111");
});

test("parent application identity fails closed on duplicates and expected-id drift", () => {
  const duplicates = [
    { id: "11111111-1111-4111-8111-111111111111", type: "self_hosted", aud: "target" },
    { id: "22222222-2222-4222-8222-222222222222", type: "self_hosted", aud: "target" },
  ];
  const duplicateResult = runHelper(`
    try {
      helper.exactParentAccessApplication(${JSON.stringify(duplicates)}, "target");
      process.exitCode = 40;
    } catch (error) {
      console.log(error.code);
    }
  `);
  assert.equal(duplicateResult.status, 0, duplicateResult.stderr);
  assert.equal(duplicateResult.stdout.trim(), "ACCESS_PARENT_APP_AMBIGUOUS");

  const single = [duplicates[0]];
  const driftResult = runHelper(`
    try {
      helper.exactParentAccessApplication(
        ${JSON.stringify(single)},
        "target",
        "99999999-9999-4999-8999-999999999999"
      );
      process.exitCode = 40;
    } catch (error) {
      console.log(error.code);
    }
  `);
  assert.equal(driftResult.status, 0, driftResult.stderr);
  assert.equal(driftResult.stdout.trim(), "ACCESS_PARENT_APP_AMBIGUOUS");
});

test("modern destinations supersede the legacy domain field", () => {
  const app = {
    domain: "control.rozkalns.net/api/github/webhook",
    destinations: [{ type: "public", uri: "https://other.example.test/path/" }],
  };
  const result = runHelper(`console.log(JSON.stringify(helper.accessApplicationPublicUris(${JSON.stringify(app)})));`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["other.example.test/path"]);
});

test("legacy domain remains a bounded read fallback when destinations are absent", () => {
  const app = { domain: "https://control.rozkalns.net/api/github/webhook/" };
  const result = runHelper(`console.log(JSON.stringify(helper.accessApplicationPublicUris(${JSON.stringify(app)})));`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["control.rozkalns.net/api/github/webhook"]);
});

test("webhook detection matches exact public destination and reserved-name collisions", () => {
  const apps = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      type: "self_hosted",
      name: "unrelated name",
      destinations: [{ type: "public", uri: "https://control.rozkalns.net/api/github/webhook/" }],
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      type: "self_hosted",
      name: "Rozkalns Control GitHub webhook",
      destinations: [{ type: "public", uri: "different.example.test" }],
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      type: "self_hosted",
      name: "near miss",
      destinations: [{ type: "public", uri: "control.rozkalns.net/api/github/webhook-extra" }],
    },
  ];
  const result = runHelper(`
    const matches = helper.exactWebhookAccessApplications(
      ${JSON.stringify(apps)},
      "control.rozkalns.net/api/github/webhook",
      "Rozkalns Control GitHub webhook"
    );
    console.log(JSON.stringify(matches.map((app) => app.id)));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ]);
});

test("activated webhook application requires the exact reviewed public destination", () => {
  const good = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "self_hosted",
    name: "Rozkalns Control GitHub webhook",
    app_launcher_visible: false,
    destinations: [{ type: "public", uri: "control.rozkalns.net/api/github/webhook" }],
  };
  const goodResult = runHelper(`
    const app = helper.assertExactWebhookAccessApplication(
      ${JSON.stringify(good)},
      ${JSON.stringify(good.id)},
      "control.rozkalns.net/api/github/webhook",
      "Rozkalns Control GitHub webhook"
    );
    console.log(app.id);
  `);
  assert.equal(goodResult.status, 0, goodResult.stderr);
  assert.equal(goodResult.stdout.trim(), good.id);

  const bad = { ...good, destinations: [{ type: "public", uri: "control.rozkalns.net/api/github/webhook-extra" }] };
  const badResult = runHelper(`
    try {
      helper.assertExactWebhookAccessApplication(
        ${JSON.stringify(bad)},
        ${JSON.stringify(good.id)},
        "control.rozkalns.net/api/github/webhook",
        "Rozkalns Control GitHub webhook"
      );
      process.exitCode = 40;
    } catch (error) {
      console.log(error.code);
    }
  `);
  assert.equal(badResult.status, 0, badResult.stderr);
  assert.equal(badResult.stdout.trim(), "ACCESS_WEBHOOK_APP_DESTINATION_INVALID");
});
