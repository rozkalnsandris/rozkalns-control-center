import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const MAX_ATTEMPTS = 3;
export const FETCH_TIMEOUT_MS = 30_000;
export const PROCESS_TIMEOUT_MS = 60_000;
export const RETRY_DELAYS_MS = [1_000, 3_000];

const TRANSPORT_PATTERNS = [
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b/i,
  /\bnetwork\s+(?:request\s+)?(?:timed?\s*out|timeout|error)\b/i,
  /\bsocket\s+hang\s+up\b/i,
  /\bfetch\s+failed\b/i,
  /\bnpm\s+(?:warn|error)\s+audit\s+5\d\d\b/i,
  /\b5\d\d\s+(?:service unavailable|bad gateway|gateway timeout|internal server error|not implemented|http version not supported|network authentication required)\b/i,
  /\b(?:http(?:\s+status|\s+error)?|status(?:\s+code)?|response)\s*[:=]?\s*5\d\d\b/i,
];

export function buildAuditArgs() {
  return [
    'audit',
    '--omit=dev',
    '--audit-level=high',
    `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
    '--fetch-retries=0',
  ];
}

export function isRetryableTransportFailure(text) {
  return TRANSPORT_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeResult(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const errorCode = typeof result?.error?.code === 'string' ? result.error.code : '';
  const exitCode = Number.isInteger(result?.status) ? result.status : 1;
  const evidence = [stdout, stderr, errorCode].filter(Boolean).join('\n');
  return { stdout, stderr, errorCode, exitCode, evidence };
}

export function runNpmAuditAttempt() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npmCommand, buildAuditArgs(), {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: PROCESS_TIMEOUT_MS,
  });
}

export async function runAuditWithRetries({
  runAttempt = runNpmAuditAttempt,
  sleepFn = sleep,
  writeStdout = (text) => process.stdout.write(text),
  writeStderr = (text) => process.stderr.write(text),
} = {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    writeStdout(`AUDIT_RUNTIME_ATTEMPT=${attempt}/${MAX_ATTEMPTS}\n`);

    const result = normalizeResult(await runAttempt(attempt));
    if (result.stdout) writeStdout(result.stdout);
    if (result.stderr) writeStderr(result.stderr);

    if (result.exitCode === 0) {
      writeStdout('AUDIT_RUNTIME_RESULT=PASS\n');
      return { exitCode: 0, attempts: attempt, classification: 'pass' };
    }

    if (!isRetryableTransportFailure(result.evidence)) {
      writeStderr('AUDIT_RUNTIME_RESULT=FAIL_NON_RETRYABLE\n');
      return {
        exitCode: result.exitCode,
        attempts: attempt,
        classification: 'non-retryable-failure',
      };
    }

    if (attempt === MAX_ATTEMPTS) {
      writeStderr('AUDIT_RUNTIME_RESULT=FAIL_TRANSPORT_EXHAUSTED\n');
      return {
        exitCode: result.exitCode,
        attempts: attempt,
        classification: 'transport-exhausted',
      };
    }

    writeStderr('AUDIT_RUNTIME_TRANSPORT_RETRY=YES\n');
    await sleepFn(RETRY_DELAYS_MS[attempt - 1]);
  }

  throw new Error('unreachable audit retry state');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await runAuditWithRetries();
  process.exitCode = result.exitCode;
}
