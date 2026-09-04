import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { runGitHubAdvisoryFallback } from './github-advisory-fallback.mjs';

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

const VULNERABILITY_EVIDENCE_PATTERNS = [
  /#\s*npm\s+audit\s+report/i,
  /\b(?:low|moderate|high|critical)\s+severity\s+vulnerabilit(?:y|ies)\b/i,
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
  if (VULNERABILITY_EVIDENCE_PATTERNS.some((pattern) => pattern.test(text))) return false;
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

export function buildAuditEnv(env = process.env) {
  const { GITHUB_TOKEN: _githubToken, GH_TOKEN: _ghToken, ...auditEnv } = env;
  return auditEnv;
}

export function runNpmAuditAttempt() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npmCommand, buildAuditArgs(), {
    encoding: 'utf8',
    env: buildAuditEnv(),
    maxBuffer: 4 * 1024 * 1024,
    timeout: PROCESS_TIMEOUT_MS,
  });
}

export async function runAuditWithRetries({
  runAttempt = runNpmAuditAttempt,
  runFallback = runGitHubAdvisoryFallback,
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
      writeStderr('AUDIT_RUNTIME_TRANSPORT_EXHAUSTED=YES\n');
      writeStdout('AUDIT_RUNTIME_FALLBACK=GITHUB_ADVISORY_DATABASE\n');

      let fallback;
      try {
        fallback = await runFallback();
      } catch (error) {
        writeStderr(`AUDIT_RUNTIME_FALLBACK_ERROR=${error?.name || 'unknown'}\n`);
        writeStderr('AUDIT_RUNTIME_RESULT=FAIL_FALLBACK_ERROR\n');
        return { exitCode: 1, attempts: attempt, classification: 'fallback-error' };
      }

      if (fallback?.classification === 'clean' && fallback.exitCode === 0) {
        writeStdout(`AUDIT_RUNTIME_FALLBACK_PACKAGES=${fallback.packagesChecked}\n`);
        writeStdout('AUDIT_RUNTIME_RESULT=PASS_FALLBACK\n');
        return { exitCode: 0, attempts: attempt, classification: 'fallback-pass' };
      }

      if (fallback?.classification === 'vulnerable' && fallback.exitCode !== 0) {
        const findings = Array.isArray(fallback.findings) ? fallback.findings : [];
        for (const finding of findings.slice(0, 20)) {
          writeStderr(`AUDIT_RUNTIME_FALLBACK_FINDING=${finding.ghsaId}:${finding.severity}\n`);
        }
        writeStderr('AUDIT_RUNTIME_RESULT=FAIL_FALLBACK_VULNERABLE\n');
        return { exitCode: 1, attempts: attempt, classification: 'fallback-vulnerable' };
      }

      writeStderr('AUDIT_RUNTIME_RESULT=FAIL_FALLBACK_ERROR\n');
      return { exitCode: 1, attempts: attempt, classification: 'fallback-error' };
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
