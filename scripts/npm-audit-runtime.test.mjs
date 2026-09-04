import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FETCH_TIMEOUT_MS,
  MAX_ATTEMPTS,
  buildAuditArgs,
  buildAuditEnv,
  isRetryableTransportFailure,
  runAuditWithRetries,
} from './npm-audit-runtime.mjs';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => { stderr += text; },
    read: () => ({ stdout, stderr }),
  };
}

function transportFailure() {
  return {
    status: 1,
    stdout: '',
    stderr: 'npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\n',
  };
}

test('pins audit scope and disables nested npm retries', () => {
  assert.deepEqual(buildAuditArgs(), [
    'audit',
    '--omit=dev',
    '--audit-level=high',
    `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
    '--fetch-retries=0',
  ]);
});

test('does not expose GitHub fallback tokens to npm audit subprocesses', () => {
  assert.deepEqual(buildAuditEnv({
    PATH: '/usr/bin',
    GITHUB_TOKEN: 'secret-a',
    GH_TOKEN: 'secret-b',
    OTHER: 'value',
  }), {
    PATH: '/usr/bin',
    OTHER: 'value',
  });
});

test('passes immediately when npm audit succeeds', async () => {
  const io = capture();
  let fallbackCalls = 0;
  const result = await runAuditWithRetries({
    runAttempt: () => ({ status: 0, stdout: 'found 0 vulnerabilities\n', stderr: '' }),
    runFallback: async () => { fallbackCalls += 1; return { exitCode: 0, classification: 'clean', packagesChecked: 1, findings: [] }; },
    sleepFn: async () => {},
    ...io,
  });

  assert.deepEqual(result, { exitCode: 0, attempts: 1, classification: 'pass' });
  assert.equal(fallbackCalls, 0);
  assert.match(io.read().stdout, /AUDIT_RUNTIME_RESULT=PASS/);
});

test('does not retry or fallback a vulnerability failure even if transport text is also present', async () => {
  const io = capture();
  let attempts = 0;
  let fallbackCalls = 0;
  const result = await runAuditWithRetries({
    runAttempt: () => {
      attempts += 1;
      return {
        status: 1,
        stdout: '# npm audit report\nexample high severity vulnerability\n',
        stderr: 'npm warn audit 503 Service Unavailable\n',
      };
    },
    runFallback: async () => { fallbackCalls += 1; return { exitCode: 0, classification: 'clean', packagesChecked: 1, findings: [] }; },
    sleepFn: async () => {},
    ...io,
  });

  assert.deepEqual(result, {
    exitCode: 1,
    attempts: 1,
    classification: 'non-retryable-failure',
  });
  assert.equal(attempts, 1);
  assert.equal(fallbackCalls, 0);
  assert.match(io.read().stderr, /FAIL_NON_RETRYABLE/);
});

test('retries explicit transport failure and then passes without fallback', async () => {
  const io = capture();
  const sequence = [
    transportFailure(),
    { status: 0, stdout: 'found 0 vulnerabilities\n', stderr: '' },
  ];
  const sleeps = [];
  let fallbackCalls = 0;

  const result = await runAuditWithRetries({
    runAttempt: () => sequence.shift(),
    runFallback: async () => { fallbackCalls += 1; return { exitCode: 0, classification: 'clean', packagesChecked: 1, findings: [] }; },
    sleepFn: async (delay) => { sleeps.push(delay); },
    ...io,
  });

  assert.deepEqual(result, { exitCode: 0, attempts: 2, classification: 'pass' });
  assert.equal(sleeps.length, 1);
  assert.equal(fallbackCalls, 0);
});

test('uses GitHub advisory fallback only after the bounded transport budget is exhausted', async () => {
  const io = capture();
  let attempts = 0;
  let fallbackCalls = 0;
  const result = await runAuditWithRetries({
    runAttempt: () => { attempts += 1; return transportFailure(); },
    runFallback: async () => {
      fallbackCalls += 1;
      return { exitCode: 0, classification: 'clean', packagesChecked: 3, findings: [] };
    },
    sleepFn: async () => {},
    ...io,
  });

  assert.deepEqual(result, { exitCode: 0, attempts: MAX_ATTEMPTS, classification: 'fallback-pass' });
  assert.equal(attempts, MAX_ATTEMPTS);
  assert.equal(fallbackCalls, 1);
  assert.match(io.read().stdout, /AUDIT_RUNTIME_RESULT=PASS_FALLBACK/);
});

test('fails closed when fallback reports a high or critical finding', async () => {
  const io = capture();
  const result = await runAuditWithRetries({
    runAttempt: transportFailure,
    runFallback: async () => ({
      exitCode: 1,
      classification: 'vulnerable',
      packagesChecked: 3,
      findings: [{ ghsaId: 'GHSA-1111-2222-3333', severity: 'high' }],
    }),
    sleepFn: async () => {},
    ...io,
  });

  assert.deepEqual(result, { exitCode: 1, attempts: MAX_ATTEMPTS, classification: 'fallback-vulnerable' });
  assert.match(io.read().stderr, /GHSA-1111-2222-3333:high/);
  assert.match(io.read().stderr, /FAIL_FALLBACK_VULNERABLE/);
});

test('fails closed when fallback is unavailable or returns an unknown state', async () => {
  const io = capture();
  const thrown = await runAuditWithRetries({
    runAttempt: transportFailure,
    runFallback: async () => { throw new Error('provider unavailable'); },
    sleepFn: async () => {},
    ...io,
  });
  assert.equal(thrown.classification, 'fallback-error');

  const unknown = await runAuditWithRetries({
    runAttempt: transportFailure,
    runFallback: async () => ({ exitCode: 0, classification: 'unknown' }),
    sleepFn: async () => {},
    ...capture(),
  });
  assert.equal(unknown.classification, 'fallback-error');
});

test('classifier rejects non-transport and mixed vulnerability failures', () => {
  assert.equal(isRetryableTransportFailure('npm error 401 Unauthorized'), false);
  assert.equal(isRetryableTransportFailure('high severity vulnerability'), false);
  assert.equal(isRetryableTransportFailure('# npm audit report\nnpm warn audit 503 Service Unavailable'), false);
  assert.equal(isRetryableTransportFailure('npm warn audit 503 Service Unavailable'), true);
  assert.equal(isRetryableTransportFailure('npm warn audit network timeout at: registry'), true);
});
