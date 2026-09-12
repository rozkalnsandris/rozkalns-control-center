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
  failure_code: number | null;
  retry_after_ms: number | null;
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

function emitDiagnostics(outputPath: string): string[] {
  const moduleUrl = pathToFileURL(resolve(DIAGNOSTICS_PATH)).href;
  const program = [
    `import { emitWranglerFailureDiagnostics } from ${JSON.stringify(moduleUrl)};`,
    "const lines = [];",
    "emitWranglerFailureDiagnostics(process.env.WRANGLER_DIAGNOSTIC_TEST_FILE, (line) => lines.push(line));",
    "process.stdout.write(JSON.stringify(lines));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_DIAGNOSTIC_TEST_FILE: outputPath },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout) as string[];
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

test("Wrangler diagnostics expose only public-safe command-failed code and retry metadata", () => {
  const payload = {
    type: "command-failed",
    version: 1,
    code: 10001,
    message: "Opaque upstream failure that must not be emitted",
    retry_after_ms: 2500,
    response: { body: "TOPSECRET_RESPONSE_BODY" },
  };

  withTempOutput(`${JSON.stringify(payload)}\n`, (path) => {
    const result = readDiagnostics(path);
    assert.equal(result.failure_code, 10001);
    assert.equal(result.retry_after_ms, 2500);
    assert.equal(result.raw_fields_emitted, false);
    assert.ok(!JSON.stringify(result).includes(payload.message));
    assert.ok(!JSON.stringify(result).includes("TOPSECRET_RESPONSE_BODY"));

    assert.deepEqual(emitDiagnostics(path), [
      "WRANGLER_FAILURE_DIAGNOSTIC=AVAILABLE",
      "WRANGLER_FAILURE_REASON=STRUCTURED_OUTPUT_PARSED",
      "WRANGLER_FAILURE_CLASS=UNKNOWN",
      "WRANGLER_FAILURE_CODE=10001",
      "WRANGLER_FAILURE_RETRY_AFTER_MS=2500",
      "WRANGLER_FAILURE_DETAIL=STRUCTURED_ERROR_PRESENT_RAW_DETAIL_SUPPRESSED",
      "WRANGLER_FAILURE_RAW_FIELDS_EMITTED=NO",
    ]);
  });
});

test("Wrangler diagnostics fail closed on invalid or ambiguous command-failed metadata", () => {
  withTempOutput(`${JSON.stringify({
    type: "command-failed",
    version: 1,
    code: "10001",
    message: "invalid code shape",
    retry_after_ms: -1,
  })}\n`, (path) => {
    const result = readDiagnostics(path);
    assert.equal(result.failure_code, null);
    assert.equal(result.retry_after_ms, null);
  });

  const conflicting = [
    { type: "command-failed", version: 1, code: 10001, retry_after_ms: 1000 },
    { type: "command-failed", version: 1, code: 10002, retry_after_ms: 2000 },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  withTempOutput(conflicting, (path) => {
    const result = readDiagnostics(path);
    assert.equal(result.failure_code, null);
    assert.equal(result.retry_after_ms, null);
  });
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
      failure_code: null,
      retry_after_ms: null,
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
      failure_code: null,
      retry_after_ms: null,
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
