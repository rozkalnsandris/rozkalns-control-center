import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("Phase 1 keeps fixture mode explicit and mock actions network-free", async () => {
  const [app, decisionCard, fixtures] = await Promise.all([
    source("src/react-app/App.tsx"),
    source("src/react-app/components/DecisionCard.tsx"),
    source("src/shared/control-fixtures.ts"),
  ]);

  assert.match(app, /FIXTURE MODE/);
  assert.match(app, /No GitHub action can execute/);
  assert.equal(decisionCard.includes("fetch("), false);
  assert.equal(fixtures.includes("https://"), false);
  assert.equal(fixtures.includes("api.github.com"), false);
});

test("Phase 1 preserves mobile touch and keyboard focus affordances", async () => {
  const css = await source("src/react-app/index.css");

  assert.match(css, /\.action-button\s*\{[\s\S]*?min-height:\s*52px;/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /\.skip-link\s*\{/);
  assert.match(css, /@media \(min-width: 640px\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
});
