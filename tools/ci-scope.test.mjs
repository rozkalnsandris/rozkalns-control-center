import assert from "node:assert/strict";
import test from "node:test";

import { classifyPaths } from "./ci-scope.mjs";

test("documentation-only changes use docs-only CI", () => {
  assert.deepEqual(
    classifyPaths([
      "README.md",
      "AGENTS.md",
      "CONTRIBUTING.md",
      "docs/FAST_LANE_V2_2.md",
    ]),
    { mode: "docs-only", docsOnly: true, full: false },
  );
});

test("source changes always use full CI", () => {
  assert.equal(classifyPaths(["src/worker/index.ts"]).full, true);
});

test("workflow changes always use full CI", () => {
  assert.equal(classifyPaths([".github/workflows/ci.yml"]).full, true);
});

test("Wrangler, test and tool changes always use full CI", () => {
  assert.equal(classifyPaths(["wrangler.jsonc"]).full, true);
  assert.equal(classifyPaths(["tests/health.test.ts"]).full, true);
  assert.equal(classifyPaths(["tools/ci-scope.mjs"]).full, true);
});

test("unknown or missing diff evidence fails open to full CI", () => {
  assert.equal(classifyPaths([]).full, true);
  assert.equal(classifyPaths(["some-new-area/file.txt"]).full, true);
});

test("one non-documentation path makes a mixed change full CI", () => {
  assert.deepEqual(
    classifyPaths(["docs/FAST_LANE_V2_2.md", "package.json"]),
    { mode: "full", docsOnly: false, full: true },
  );
});
