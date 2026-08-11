import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("TypeScript linting keeps typed floating-Promise protection enabled", async () => {
  const config = await readFile("eslint.config.js", "utf8");

  assert.match(config, /files:\s*\["\*\*\/\*\.\{ts,tsx\}"\]/);
  assert.match(config, /projectService:\s*true/);
  assert.match(config, /tsconfigRootDir:\s*import\.meta\.dirname/);
  assert.match(config, /"@typescript-eslint\/no-floating-promises":\s*"error"/);
});

test("JavaScript utility scripts remain outside the typed TypeScript lint target", async () => {
  const config = await readFile("eslint.config.js", "utf8");

  assert.match(config, /files:\s*\["scripts\/\*\*\/\*\.mjs"\]/);
});
