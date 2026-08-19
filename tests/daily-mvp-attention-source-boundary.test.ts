import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const appSource = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
const cssSource = readFileSync(resolve(process.cwd(), "src/react-app/daily-mvp.css"), "utf8");

test("operator attention remains read-only and suppresses empty secondary sections", () => {
  assert.match(appSource, /operatorAttentionForSummary\(summary\)/);
  assert.match(appSource, /id="needs-andris"/);
  assert.match(appSource, /id="ci-failed"/);
  assert.match(appSource, /workingOrWaiting\.length > 0/);
  assert.match(appSource, /ciFailed\.length > 0/);
  assert.match(appSource, /mergeReady\.length > 0/);
  assert.match(appSource, /href=\{attention\.target\}/);

  assert.doesNotMatch(appSource, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
  assert.doesNotMatch(appSource, /\/api\/github\/needs-changes["']/);

  assert.match(cssSource, /\.operator-attention__action/);
  assert.match(cssSource, /min-height:\s*48px/);
});
