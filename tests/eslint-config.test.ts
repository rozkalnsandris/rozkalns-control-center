import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runtime TypeScript linting keeps typed floating-Promise protection enabled", async () => {
  const config = await readFile("eslint.config.js", "utf8");

  assert.match(config, /files:\s*\["src\/\*\*\/\*\.\{ts,tsx\}"\]/);
  assert.match(config, /projectService:\s*true/);
  assert.match(config, /tsconfigRootDir:\s*import\.meta\.dirname/);
  assert.match(config, /"@typescript-eslint\/no-floating-promises":\s*"error"/);
});

test("test and JavaScript utility registrations stay outside the typed runtime-source rule", async () => {
  const config = await readFile("eslint.config.js", "utf8");

  assert.match(config, /files:\s*\["tests\/\*\*\/\*\.ts"\]/);
  assert.match(config, /files:\s*\["scripts\/\*\*\/\*\.mjs"\]/);
});
