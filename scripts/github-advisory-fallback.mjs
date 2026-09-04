import { readFile } from 'node:fs/promises';

export const GITHUB_ADVISORY_API = 'https://api.github.com/advisories';
export const GITHUB_API_VERSION = '2026-03-10';
export const FALLBACK_FETCH_TIMEOUT_MS = 15_000;
export const FALLBACK_PACKAGE_CHUNK_SIZE = 20;
export const FALLBACK_MAX_PAGES = 10;

const REGISTRY_PREFIX = 'https://registry.npmjs.org/';

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) return null;
  const name = lockPath.slice(index + marker.length);
  if (!name || name.includes('/node_modules/')) return null;
  if (name.startsWith('@')) {
    const parts = name.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  } else if (name.includes('/')) {
    return null;
  }
  return name;
}

export function collectRuntimePackages(lockfile) {
  assertObject(lockfile, 'package-lock must be an object');
  if (lockfile.lockfileVersion !== 3) {
    throw new Error(`unsupported package-lock version: ${String(lockfile.lockfileVersion)}`);
  }

  const packages = assertObject(lockfile.packages, 'package-lock packages must be an object');
  const root = assertObject(packages[''], 'package-lock root package is missing');
  const rootDependencies = root.dependencies == null
    ? {}
    : assertObject(root.dependencies, 'package-lock root dependencies must be an object');

  const seen = new Map();
  for (const [lockPath, metadataRaw] of Object.entries(packages)) {
    if (lockPath === '') continue;
    const metadata = assertObject(metadataRaw, `invalid lock entry: ${lockPath}`);
    if (metadata.dev === true) continue;
    if (metadata.link === true) {
      throw new Error(`unsupported linked runtime package: ${lockPath}`);
    }

    const name = packageNameFromLockPath(lockPath);
    if (!name) {
      throw new Error(`unsupported runtime package path: ${lockPath}`);
    }
    if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
      throw new Error(`runtime package version missing: ${lockPath}`);
    }
    if (typeof metadata.resolved !== 'string' || !metadata.resolved.startsWith(REGISTRY_PREFIX)) {
      throw new Error(`runtime package is not pinned to npm registry: ${lockPath}`);
    }

    const spec = `${name}@${metadata.version}`;
    seen.set(spec, { name, version: metadata.version, spec });
  }

  const result = [...seen.values()].sort((a, b) => a.spec.localeCompare(b.spec));
  if (Object.keys(rootDependencies).length > 0 && result.length === 0) {
    throw new Error('runtime dependency set unexpectedly empty');
  }
  return result;
}

export function buildAdvisoryUrl(packageSpecs, { type, severity } = {}) {
  if (!Array.isArray(packageSpecs) || packageSpecs.length === 0) {
    throw new Error('advisory query requires package specs');
  }
  const url = new URL(GITHUB_ADVISORY_API);
  url.searchParams.set('type', type);
  url.searchParams.set('ecosystem', 'npm');
  if (severity) url.searchParams.set('severity', severity);
  url.searchParams.set('is_withdrawn', 'false');
  url.searchParams.set('per_page', '100');
  url.searchParams.set('affects', packageSpecs.join(','));
  return url;
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') return match[1];
  }
  return null;
}

function validateNextUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://api.github.com' || url.pathname !== '/advisories') {
    throw new Error('unexpected advisory pagination URL');
  }
  return url;
}

async function fetchAllPages(initialUrl, { fetchFn, token }) {
  const advisories = [];
  let url = initialUrl;
  for (let page = 1; page <= FALLBACK_MAX_PAGES; page += 1) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'rozkalns-control-center-ci-audit-fallback',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(FALLBACK_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`GitHub advisory request failed: ${error?.name || 'network-error'}`);
    }

    if (!response || response.ok !== true) {
      throw new Error(`GitHub advisory HTTP failure: ${String(response?.status ?? 'unknown')}`);
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('GitHub advisory response was not valid JSON');
    }
    if (!Array.isArray(body)) {
      throw new Error('GitHub advisory response was not an array');
    }
    for (const item of body) {
      assertObject(item, 'GitHub advisory item was not an object');
      if (typeof item.ghsa_id !== 'string' || item.ghsa_id.length === 0) {
        throw new Error('GitHub advisory item missing ghsa_id');
      }
      advisories.push(item);
    }

    const next = nextLink(response.headers?.get?.('link'));
    if (!next) return advisories;
    url = validateNextUrl(next);
  }
  throw new Error('GitHub advisory pagination exceeded bounded limit');
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function runGitHubAdvisoryFallback({
  lockfilePath = 'package-lock.json',
  readFileFn = readFile,
  fetchFn = globalThis.fetch,
  token = process.env.GITHUB_TOKEN || '',
} = {}) {
  if (typeof fetchFn !== 'function') {
    return { exitCode: 1, classification: 'error', reason: 'fetch-unavailable' };
  }

  try {
    const raw = await readFileFn(lockfilePath, 'utf8');
    const lockfile = JSON.parse(raw);
    const runtimePackages = collectRuntimePackages(lockfile);
    const packageSpecs = runtimePackages.map((entry) => entry.spec);
    const findings = [];

    for (const group of chunks(packageSpecs, FALLBACK_PACKAGE_CHUNK_SIZE)) {
      const queries = [
        { type: 'reviewed', severity: 'high' },
        { type: 'reviewed', severity: 'critical' },
        { type: 'malware' },
      ];
      for (const query of queries) {
        const advisories = await fetchAllPages(buildAdvisoryUrl(group, query), { fetchFn, token });
        for (const advisory of advisories) {
          if (advisory.type !== query.type) {
            throw new Error('GitHub advisory type did not match query');
          }
          if (query.severity && advisory.severity !== query.severity) {
            throw new Error('GitHub advisory severity did not match query');
          }
          if (advisory.withdrawn_at != null) {
            throw new Error('withdrawn GitHub advisory returned despite filter');
          }
          findings.push({
            ghsaId: advisory.ghsa_id,
            type: query.type,
            severity: query.severity || 'malware',
          });
        }
      }
    }

    if (findings.length > 0) {
      return {
        exitCode: 1,
        classification: 'vulnerable',
        packagesChecked: runtimePackages.length,
        findings,
      };
    }

    return {
      exitCode: 0,
      classification: 'clean',
      packagesChecked: runtimePackages.length,
      findings: [],
    };
  } catch (error) {
    return {
      exitCode: 1,
      classification: 'error',
      reason: error instanceof Error ? error.message : 'unknown fallback error',
    };
  }
}
