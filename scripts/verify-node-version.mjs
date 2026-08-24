import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const expected = readFileSync(resolve(root, '.nvmrc'), 'utf8').trim();
const actual = process.versions.node;

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  console.error('NODE_VERSION=STOP');
  console.error('STOP=CANONICAL_NODE_VERSION_INVALID');
  process.exit(1);
}

if (actual !== expected) {
  console.error('NODE_VERSION=STOP');
  console.error(`EXPECTED_NODE_VERSION=${expected}`);
  console.error(`ACTUAL_NODE_VERSION=${actual}`);
  process.exit(1);
}

console.log('NODE_VERSION=PASS');
console.log(`EXPECTED_NODE_VERSION=${expected}`);
console.log(`ACTUAL_NODE_VERSION=${actual}`);
