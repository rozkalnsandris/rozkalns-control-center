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

test("compact portrait phone profile remains safe for Galaxy A55-class screens", async () => {
  const [compactCss, html, main] = await Promise.all([
    source("src/react-app/compact-phone.css"),
    source("index.html"),
    source("src/react-app/main.tsx"),
  ]);

  assert.match(html, /viewport-fit=cover/);
  assert.match(main, /compact-phone\.css/);
  assert.match(compactCss, /@media \(max-width: 430px\)/);
  assert.match(compactCss, /@supports \(height: 100dvh\)/);
  assert.match(compactCss, /env\(safe-area-inset-top\)/);
  assert.match(compactCss, /\.action-row\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(compactCss, /\.action-button\s*\{[\s\S]*?min-height:\s*52px;/);
});
