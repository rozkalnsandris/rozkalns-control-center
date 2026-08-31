import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const canonicalTemplate = ".github/PULL_REQUEST_TEMPLATE.md";
const duplicateTemplate = ".github/pull_request_template.md";

test("repository keeps one canonical pull request template with required safety fields", () => {
  assert.equal(existsSync(canonicalTemplate), true);
  assert.equal(existsSync(duplicateTemplate), false);

  const template = readFileSync(canonicalTemplate, "utf8");

  for (const heading of [
    "## Summary",
    "## Scope",
    "## Risk",
    "## Testing",
    "## Review",
    "## Deploy impact",
    "## Ready receipt",
  ]) {
    assert.match(template, new RegExp(`^${heading.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "m"));
  }

  assert.match(template, /Automated review\/check state:/);
  assert.match(template, /Human review state:/);
  assert.match(template, /Unresolved review threads:/);
  assert.match(template, /Exact head SHA:/);
  assert.match(template, /GitHub App permission or trust-boundary changed:/);
  assert.match(template, /Deploy required:/);
  assert.match(template, /Merge authority must come from the active lane\/issue contract\./);
  assert.match(template, /Merge never authorizes deploy/);
  assert.doesNotMatch(template, /FAST-LANE v2\.1/);
});
