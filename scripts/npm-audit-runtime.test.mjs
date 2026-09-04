import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FETCH_TIMEOUT_MS,
  MAX_ATTEMPTS,
  buildAuditArgs,
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

test('pins audit scope and disables nested npm retries', () => {
  assert.deepEqual(buildAuditArgs(), [
    'audit',
    '--omit=dev',
    '--audit-level=high',
    `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
    '--fetch-retries=0',
  ]);
});

test('passes immediately when npm audit succeeds', async () => {
  const io = capture();
  let attempts = 0;
  const result = await runAuditWithRetries({
    runAttempt: () => {
      attempts += 1;
      return { status: 0, stdout: 'found 0 vulnerabilities\n', stderr: '' };
    },
    sleepFn: async () => {},
    ...io,
  });

  assert.deepEqual(result, { exitCode: 0, attempts: 1, classification: 'pass' });
  assert.equal(attempts, 1);
  assert.match(io.read().stdout, /AUDIT_RUNTIME_RESULT=PASS/);
});

test('does not retry a vulnerability failure', async () => {
  const io = capture();
  let attempts = 0;
  const result = await runAuditWithRetries({
    runAttempt: () => {
      attempts += 1;
      return {
        status: 1,
        stdout: '# npm audit report\nexample high severity vulnerability\n',
        stderr: '',
      };
    },
    sleepFn: async () => {},
    ...io,
  });

  assert.deepEqual(result, {
    exitCode: 1,
    attempts: 1,
    classification: 'non-retryable-failure',
  });
  assert.equal(attempts, 1);
  assert.match(io.read().stderr, /FAIL_NON_RETRYABLE/);
});

test('retries explicit transport failure and then passes', async () => {
  const io = capture();
  const sequence = [
    {
      status: 1,
      stdout: '',
      stderr: 'npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\n',
    },
    { status: 0, stdout: 'found 0 vulnerabilities\n', stderr: '' },
  ];
  const sleeps = [];

  const result = await runAuditWithRetries({
    runAttempt: () => sequence.shift(),
    sleepFn: async (delay) => { sleeps.push(delay); },
    ...io,
  });

  assert.deepEqual(result, { exitCode: 0, attempts: 2, classification: 'pass' });
  assert.equal(sleeps.length, 1);
  assert.match(io.read().stderr, /AUDIT_RUNTIME_TRANSPORT_RETRY=YES/);
});

test('fails closed after the bounded transport retry budget is exhausted', async () => {
  const io = capture();
  let attempts = 0;
  const result = await runAuditWithRetries({
    runAttempt: () => {
      attempts += 1;
      return {
        status: 1,
        stdout: '',
        stderr: 'npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\n',
      };
    },
    sleepFn: async () => {},
    ...io,
  });

  assert.deepEqual(result, {
    exitCode: 1,
    attempts: MAX_ATTEMPTS,
    classification: 'transport-exhausted',
  });
  assert.equal(attempts, MAX_ATTEMPTS);
  assert.match(io.read().stderr, /FAIL_TRANSPORT_EXHAUSTED/);
});

test('classifier rejects non-transport audit failures', () => {
  assert.equal(isRetryableTransportFailure('npm error 401 Unauthorized'), false);
  assert.equal(isRetryableTransportFailure('high severity vulnerability'), false);
  assert.equal(isRetryableTransportFailure('npm warn audit 503 Service Unavailable'), true);
  assert.equal(isRetryableTransportFailure('npm warn audit network timeout at: registry'), true);
});
