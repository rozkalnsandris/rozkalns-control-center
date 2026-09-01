import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const APP = "src/react-app/App.tsx";
const CARD = "src/react-app/components/DecisionCard.tsx";
const CSS = "src/react-app/index.css";

test("public UI keeps the 320–430px mobile-first decision contract with confirmed live actions", async () => {
  const [app, card, css, liveCss] = await Promise.all([
    readFile(APP, "utf8"),
    readFile(CARD, "utf8"),
    readFile(CSS, "utf8"),
    readFile("src/react-app/live-dashboard.css", "utf8"),
  ]);

  assert.match(css, /min-width:\s*320px/);
  assert.match(css, /@media \(max-width:\s*430px\)/);
  assert.match(css, /\.topbar > \.status-pill/);
  assert.match(css, /\.action-button--primary[\s\S]*grid-column:\s*1 \/ -1/);
  assert.match(css, /\.action-button--tertiary[\s\S]*grid-column:\s*1 \/ -1/);
  assert.match(liveCss, /\.action-button\[href\]/);

  assert.equal(app.includes("control-status-strip"), true);
  assert.equal(app.includes("Decision control"), true);
  assert.equal(app.includes("hero__system"), false);
  assert.equal(app.includes("fixture-notice"), false);
  assert.equal(app.includes('fetch("/api/github/dashboard"'), true);
  assert.equal(app.includes("AbortController"), true);
  assert.equal(app.includes("LIVE CONTROL"), true);
  assert.equal(app.includes("Live data unavailable · fixture data shown"), true);
  assert.equal(app.includes("api.github.com"), false);

  assert.equal(card.includes('<details className="evidence-details">'), true);
  assert.equal(card.includes("<summary>{evidenceLabel}</summary>"), true);
  assert.equal(card.includes("Expected head"), true);
  assert.equal(card.includes("Observed head"), true);
  assert.equal(card.includes("action-button--primary"), true);
  assert.equal(card.includes("action-button--secondary"), true);
  assert.equal(card.includes("action-button--tertiary"), true);
  assert.equal(card.includes("fetch("), false);
  assert.equal(card.includes("api.github.com"), false);
  assert.match(card, /if\s*\(\s*action\s*===\s*"OPEN_PR"\s*\)/);
  assert.equal(card.includes('target="_blank"'), false);
  assert.match(card, /onAction\(action,\s*renderedItem,\s*project\)/);
  assert.equal(card.includes('type="button"'), true);
});
