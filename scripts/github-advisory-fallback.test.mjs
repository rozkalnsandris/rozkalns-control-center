import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAdvisoryUrl,
  collectRuntimePackages,
  runGitHubAdvisoryFallback,
} from './github-advisory-fallback.mjs';

function lockfileFixture() {
  return {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: {
          react: '19.2.1',
          '@scope/runtime': '1.2.3',
        },
      },
      'node_modules/react': {
        version: '19.2.1',
        resolved: 'https://registry.npmjs.org/react/-/react-19.2.1.tgz',
      },
      'node_modules/@scope/runtime': {
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/@scope/runtime/-/runtime-1.2.3.tgz',
      },
      'node_modules/dev-only': {
        version: '9.9.9',
        resolved: 'https://registry.npmjs.org/dev-only/-/dev-only-9.9.9.tgz',
        dev: true,
      },
    },
  };
}

function jsonResponse(body, { status = 200, link = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'link' ? link : null;
      },
    },
    async json() {
      return body;
    },
  };
}

test('collects only non-dev npm registry packages from lockfile v3', () => {
  assert.deepEqual(collectRuntimePackages(lockfileFixture()), [
    { name: '@scope/runtime', version: '1.2.3', spec: '@scope/runtime@1.2.3' },
    { name: 'react', version: '19.2.1', spec: 'react@19.2.1' },
  ]);
});

test('fails closed on unsupported runtime lock entries', () => {
  const fixture = lockfileFixture();
  fixture.packages['node_modules/react'].resolved = 'git+https://example.invalid/react.git';
  assert.throws(() => collectRuntimePackages(fixture), /not pinned to npm registry/);

  fixture.packages['node_modules/react'].resolved = 'https://registry.npmjs.org/react/-/react-19.2.1.tgz';
  fixture.lockfileVersion = 2;
  assert.throws(() => collectRuntimePackages(fixture), /unsupported package-lock version/);
});

test('builds exact npm package@version advisory queries', () => {
  const url = buildAdvisoryUrl(['@scope/runtime@1.2.3', 'react@19.2.1'], {
    type: 'reviewed',
    severity: 'high',
  });
  assert.equal(url.origin, 'https://api.github.com');
  assert.equal(url.pathname, '/advisories');
  assert.equal(url.searchParams.get('type'), 'reviewed');
  assert.equal(url.searchParams.get('ecosystem'), 'npm');
  assert.equal(url.searchParams.get('severity'), 'high');
  assert.equal(url.searchParams.get('is_withdrawn'), 'false');
  assert.equal(url.searchParams.get('affects'), '@scope/runtime@1.2.3,react@19.2.1');
});

test('passes only when reviewed high/critical and malware queries are clean', async () => {
  const calls = [];
  const result = await runGitHubAdvisoryFallback({
    readFileFn: async () => JSON.stringify(lockfileFixture()),
    token: 'test-token',
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse([]);
    },
  });

  assert.deepEqual(result, {
    exitCode: 0,
    classification: 'clean',
    packagesChecked: 2,
    findings: [],
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
});

test('fails when a reviewed high advisory affects the runtime set', async () => {
  const result = await runGitHubAdvisoryFallback({
    readFileFn: async () => JSON.stringify(lockfileFixture()),
    fetchFn: async (url) => {
      const parsed = new URL(url);
      if (parsed.searchParams.get('type') === 'reviewed' && parsed.searchParams.get('severity') === 'high') {
        return jsonResponse([{ ghsa_id: 'GHSA-1111-2222-3333', type: 'reviewed', severity: 'high', withdrawn_at: null }]);
      }
      return jsonResponse([]);
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.classification, 'vulnerable');
  assert.deepEqual(result.findings, [
    { ghsaId: 'GHSA-1111-2222-3333', type: 'reviewed', severity: 'high' },
  ]);
});

test('fails when a malware advisory affects the runtime set', async () => {
  const result = await runGitHubAdvisoryFallback({
    readFileFn: async () => JSON.stringify(lockfileFixture()),
    fetchFn: async (url) => {
      const parsed = new URL(url);
      if (parsed.searchParams.get('type') === 'malware') {
        return jsonResponse([{ ghsa_id: 'GHSA-aaaa-bbbb-cccc', type: 'malware', severity: 'critical', withdrawn_at: null }]);
      }
      return jsonResponse([]);
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.classification, 'vulnerable');
  assert.equal(result.findings[0].severity, 'malware');
});

test('fails closed on provider HTTP or malformed response semantics', async () => {
  const httpFailure = await runGitHubAdvisoryFallback({
    readFileFn: async () => JSON.stringify(lockfileFixture()),
    fetchFn: async () => jsonResponse({ message: 'rate limited' }, { status: 429 }),
  });
  assert.equal(httpFailure.classification, 'error');

  const malformed = await runGitHubAdvisoryFallback({
    readFileFn: async () => JSON.stringify(lockfileFixture()),
    fetchFn: async () => jsonResponse([{ ghsa_id: 'GHSA-1111-2222-3333', type: 'reviewed', severity: 'medium', withdrawn_at: null }]),
  });
  assert.equal(malformed.classification, 'error');
});

test('follows bounded GitHub pagination only on the advisory endpoint', async () => {
  let calls = 0;
  const result = await runGitHubAdvisoryFallback({
    readFileFn: async () => JSON.stringify(lockfileFixture()),
    fetchFn: async (url) => {
      calls += 1;
      const parsed = new URL(url);
      if (parsed.searchParams.get('type') === 'reviewed' && parsed.searchParams.get('severity') === 'high' && !parsed.searchParams.has('page')) {
        return jsonResponse([], {
          link: '<https://api.github.com/advisories?type=reviewed&ecosystem=npm&severity=high&page=2>; rel="next"',
        });
      }
      return jsonResponse([]);
    },
  });

  assert.equal(result.classification, 'clean');
  assert.equal(calls, 4);
});
