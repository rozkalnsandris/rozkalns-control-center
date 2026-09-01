import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  decisionDeepLinkHash,
  decisionDeepLinkPath,
  decisionTargetId,
  decisionTargetIdFromHash,
} from "../src/shared/decision-deep-link.js";

const decisionCardSource = readFileSync(
  resolve(process.cwd(), "src/react-app/components/DecisionCard.tsx"),
  "utf8",
);
const dailyMvpCss = readFileSync(resolve(process.cwd(), "src/react-app/daily-mvp.css"), "utf8");

test("decision deep links are deterministic, URL-safe and collision-resistant for normalized ids", () => {
  const decisionId = "github:hermes-deals:pr:517";
  const targetId = "decision-6769746875623a6865726d65732d6465616c733a70723a353137";

  assert.equal(decisionTargetId(decisionId), targetId);
  assert.equal(decisionDeepLinkHash(decisionId), `#${targetId}`);
  assert.equal(decisionDeepLinkPath(decisionId), `/#${targetId}`);
  assert.equal(decisionTargetIdFromHash(`#${targetId}`), targetId);
  assert.match(decisionTargetId("github:projekts-ā:pr:1"), /^decision-(?:[0-9a-f]{2})+$/);
  assert.notEqual(decisionTargetId("a:b"), decisionTargetId("a-b"));
  assert.equal(decisionTargetId(""), "decision-empty");
});

test("decision deep-link parsing rejects unrelated or malformed fragments", () => {
  assert.equal(decisionTargetIdFromHash("#ci-failed"), null);
  assert.equal(decisionTargetIdFromHash("decision-6162"), null);
  assert.equal(decisionTargetIdFromHash("#decision-6"), null);
  assert.equal(decisionTargetIdFromHash("#decision-%3A"), null);
  assert.equal(decisionTargetIdFromHash("#decision-xyz"), null);
});

test("DecisionCard wires native fragment targets and async live-mount recovery without direct network transport", () => {
  assert.match(decisionCardSource, /decisionTargetId\(item\.id\)/);
  assert.match(decisionCardSource, /decisionDeepLinkHash\(item\.id\)/);
  assert.match(decisionCardSource, /id=\{targetId\}/);
  assert.match(decisionCardSource, /tabIndex=\{-1\}/);
  assert.match(decisionCardSource, /requestAnimationFrame/);
  assert.match(decisionCardSource, /scrollIntoView\(\{ block: "center" \}\)/);
  assert.match(decisionCardSource, /focus\(\{ preventScroll: true \}\)/);
  assert.match(decisionCardSource, /action\s*===\s*"OPEN_PR"/);
  assert.match(decisionCardSource, /onAction\(action,\s*renderedItem,\s*project\)/);
  assert.doesNotMatch(decisionCardSource, /navigator\.clipboard/);
  assert.doesNotMatch(decisionCardSource, /fetch\(/);

  assert.match(dailyMvpCss, /\.decision-card:target/);
  assert.match(dailyMvpCss, /\.decision-card\s*\{[\s\S]*scroll-margin-top:\s*16px/);
});
