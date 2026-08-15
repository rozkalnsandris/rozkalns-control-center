import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gate = readFileSync("scripts/cloudflare-webhook-queue-reconciliation-gate.mjs", "utf8");
const queueHelper = readFileSync("scripts/cloudflare-queue-runtime-identity.mjs", "utf8");

test("reconciliation gate is explicitly Access-only and never replays Queue creation or Worker deploy", () => {
  assert.match(gate, /RECONCILIATION_WRITE_SCOPE=ACCESS_APP_AND_POLICY_ONLY/);
  assert.match(gate, /QUEUE_CREATE=FORBIDDEN/);
  assert.match(gate, /WORKER_DEPLOY=FORBIDDEN/);
  assert.match(gate, /QUEUE_CREATE=NOT_PERFORMED/);
  assert.match(gate, /WORKER_DEPLOY=NOT_PERFORMED/);
  assert.doesNotMatch(gate, /wranglerPath\(\), \["deploy"/);
  assert.doesNotMatch(gate, /cfWrite\(apiToken, "\/queues"/);
  assert.doesNotMatch(gate, /cfWrite\(apiToken, `\/queues/);
});

test("reconciliation gate creates only the exact webhook Access application and local bypass policy", () => {
  assert.match(gate, /cfWrite\(apiToken, "\/access\/apps", "POST"/);
  assert.match(gate, /cfWrite\(apiToken, `\/access\/apps\/\$\{encodeURIComponent\(accessApp\.id\)\}\/policies`, "POST"/);
  assert.match(gate, /destinations: \[\{ type: "public", uri: WEBHOOK_ACCESS_DOMAIN \}\]/);
  assert.match(gate, /decision: "bypass"/);
  assert.match(gate, /include: \[\{ everyone: \{\} \}\]/);
  assert.match(gate, /app_launcher_visible: false/);
});

test("reconciliation apply re-proves partial state and webhook secret before WRITE_STARTED", () => {
  const writeIndex = gate.indexOf('console.log("WRITE_STARTED=YES")');
  assert.ok(writeIndex > 0);
  for (const marker of [
    'assertRepo(args.sha)',
    'assertCi(args.sha, args.ci)',
    'readPartialState(apiToken, audience, args, true, "PREWRITE")',
    'assertSignedPing(webhookSecret, "PREWRITE", accessToken)',
    'readPartialState(apiToken, audience, args, true, "FINAL_PREWRITE")',
  ]) {
    const index = gate.indexOf(marker);
    assert.ok(index >= 0, `missing ${marker}`);
    assert.ok(index < writeIndex, `${marker} must occur before WRITE_STARTED`);
  }
  assert.match(gate, /AUTHORIZATION_CONSUMED=YES/);
  assert.match(gate, /NO_BLIND_RETRY_IF_STOP_AFTER_WRITE_STARTED=YES/);
  assert.match(gate, /POST_WRITE_STATE=RECONCILE_REQUIRED/);
});

test("owner authorization binds the full partial-runtime identity", () => {
  assert.match(gate, /authorize Phase 2 webhook reconciliation/);
  for (const field of [
    "version",
    "deployment",
    "domain",
    "access",
    "aud",
    "mainq",
    "mainc",
    "dlq",
    "dlqc",
    "deliveries",
    "webhook absent",
  ]) {
    assert.match(gate, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Queue consumer script_name is optional attestation, not an unconditional response requirement", () => {
  assert.match(queueHelper, /script_name as optional/);
  assert.match(queueHelper, /consumer\?\.script_name !== undefined && consumer\?\.script_name !== null/);
  assert.match(queueHelper, /QUEUE_CONSUMER_SCRIPT_MISMATCH/);
  assert.match(queueHelper, /consumers\.length !== 1/);
});

test("reconciliation pings are required to remain side-effect-free in D1", () => {
  assert.match(gate, /PREWRITE.*PING/s);
  assert.match(gate, /PUBLIC_SIGNED_PING=PASS/);
  assert.match(gate, /side-effect-free reconciliation ping unexpectedly changed delivery durability state/);
  assert.match(gate, /SELECT COUNT\(\*\) AS count FROM webhook_deliveries/);
  assert.match(gate, /result\?\.meta\?\.changed_db === true/);
});