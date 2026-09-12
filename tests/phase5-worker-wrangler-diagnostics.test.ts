import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type Diagnostics = {
  diagnostic: string;
  reason: string;
  classification: string;
  detail: string;
  raw_fields_emitted: boolean;
};

const DIAGNOSTICS_PATH = "scripts/phase5-worker-wrangler-diagnostics.mjs";
const EXECUTOR_PATH = "scripts/phase5-rpi5-observation-worker-activate-live.mjs";

function readDiagnostics(outputPath: string): Diagnostics {
  const moduleUrl = pathToFileURL(resolve(DIAGNOSTICS_PATH)).href;
  const program = [
    `import { readWranglerFailureDiagnostics } from ${JSON.stringify(moduleUrl)};`,
    "const result = readWranglerFailureDiagnostics(process.env.WRANGLER_DIAGNOSTIC_TEST_FILE);",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_DIAGNOSTIC_TEST_FILE: outputPath },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout) as Diagnostics;
}

function withTempOutput(content: string | null, run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "phase5-wrangler-diagnostics-"));
  const path = join(directory, "wrangler.ndjson");
  try {
    if (content !== null) writeFileSync(path, content, { mode: 0o600 });
    run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Wrangler diagnostics classify common failure families without returning raw detail", () => {
  const cases = [
    {
      classification: "AUTH",
      message: "Authentication failed because the API token is invalid",
    },
    {
      classification: "PERMISSION",
      message: "Permission denied because the credential has insufficient scope",
    },
    {
      classification: "CONFIG",
      message: "Configuration validation failed for a binding",
    },
    {
      classification: "STRICT_CONFLICT",
      message: "Strict mode conflict: automatic provisioning would be required",
    },
  ];

  for (const item of cases) {
    withTempOutput(`${JSON.stringify({ type: "error", message: item.message })}\n`, (path) => {
      const result = readDiagnostics(path);
      assert.equal(result.diagnostic, "AVAILABLE");
      assert.equal(result.classification, item.classification);
      assert.equal(result.raw_fields_emitted, false);
      assert.match(result.detail, /RAW_DETAIL_SUPPRESSED$/);
      assert.ok(JSON.stringify(result).length < 512);
    });
  }
});

test("Wrangler diagnostics suppress secret-like fields and values even when used for classification", () => {
  const secrets = [
    "TOPSECRET_TOKEN_123",
    "TOPSECRET_AUTHORIZATION_456",
    "TOPSECRET_CONFIG_VALUE_789",
    "TOPSECRET_MESSAGE_VALUE_ABC",
  ];
  const payload = {
    type: "error",
    message: `Authentication failed for token ${secrets[3]}`,
    token: secrets[0],
    authorization: `Bearer ${secrets[1]}`,
    config: { vars: { CONTROL_RPI5_OBSERVATION_VERIFICATION_KEYS: secrets[2] } },
    value: secrets[2],
  };

  withTempOutput(`${JSON.stringify(payload)}\n`, (path) => {
    const result = readDiagnostics(path);
    assert.equal(result.classification, "AUTH");
    assert.equal(result.raw_fields_emitted, false);
    const rendered = JSON.stringify(result);
    for (const secret of secrets) assert.ok(!rendered.includes(secret));
  });
});

test("Wrangler diagnostics fail closed to bounded unavailable receipts for missing or malformed output", () => {
  withTempOutput(null, (path) => {
    const result = readDiagnostics(path);
    assert.deepEqual(result, {
      diagnostic: "UNAVAILABLE",
      reason: "OUTPUT_MISSING",
      classification: "UNKNOWN",
      detail: "SANITIZED_STRUCTURED_OUTPUT_UNAVAILABLE",
      raw_fields_emitted: false,
    });
  });

  withTempOutput("not-json\n{still-not-json\n", (path) => {
    const result = readDiagnostics(path);
    assert.deepEqual(result, {
      diagnostic: "UNAVAILABLE",
      reason: "OUTPUT_MALFORMED",
      classification: "UNKNOWN",
      detail: "SANITIZED_STRUCTURED_OUTPUT_UNAVAILABLE",
      raw_fields_emitted: false,
    });
  });
});

test("Worker activation executor emits structured diagnostics before the existing fail-closed stop", () => {
  const executor = readFileSync(EXECUTOR_PATH, "utf8");
  assert.match(executor, /phase5-worker-wrangler-diagnostics\.mjs/);
  const diagnostic = executor.indexOf("emitWranglerFailureDiagnostics(outputPath)");
  const stop = executor.indexOf('stop("WRANGLER_WRITE_FAILED"');
  assert.ok(diagnostic >= 0 && stop > diagnostic);
  assert.match(executor, /WRANGLER_OUTPUT_FILE_PATH: outputPath/);
  assert.doesNotMatch(executor, /console\.(?:log|error)\(result\.(?:stdout|stderr)/);
});
