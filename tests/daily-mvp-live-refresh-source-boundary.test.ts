import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const appSource = readFileSync(resolve(process.cwd(), "src/react-app/App.tsx"), "utf8");
const mainSource = readFileSync(resolve(process.cwd(), "src/react-app/main.tsx"), "utf8");
const refreshCss = readFileSync(resolve(process.cwd(), "src/react-app/daily-mvp.css"), "utf8");

test("Daily MVP refresh stays explicit and action-aware while canonical dashboard reads remain GET-only", () => {
  assert.match(appSource, /type LiveDashboardState = .*"REFRESHING"/);
  assert.match(appSource, /const\s*\[\s*refreshSequence\s*,\s*setRefreshSequence\s*\]\s*=\s*useState\(0\)/);
  assert.match(appSource, /readControlJson\("\/api\/github\/dashboard"/);
  assert.match(appSource, /\[refreshSequence\]/);
  assert.match(appSource, /setLiveState\(liveDashboard\s*\?\s*"REFRESHING"\s*:\s*"LOADING"\)/);
  assert.match(appSource, /aria-label="Refresh live GitHub state"/);
  assert.match(appSource, /disabled=\{refreshInFlight\s*\|\|\s*actionInFlight\}/);
  assert.match(appSource, /Live service error/);
  assert.match(appSource, /const\s+live\s*=\s*liveDashboard\s*!==\s*null/);
  assert.match(appSource, /refreshLiveDashboard\(true\)/);

  assert.doesNotMatch(appSource, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
  assert.doesNotMatch(appSource, /\/api\/github\/needs-changes["']/);
  // The owner panel may expire local eligibility without polling GitHub.
  const clock = appSource.match(/window\.setInterval\(\(\)=>\{([\s\S]*?)\},5000\)/);
  assert.ok(clock, "local freshness clock is present");
  assert.doesNotMatch(clock[1], /fetch|readControlJson|refreshLiveDashboard|setRefreshSequence|postDecisionAction/);
  assert.match(clock[1], /classifyDashboardFreshness/);
  assert.match(clock[1], /setLiveState/);

  assert.match(mainSource, /\.\/daily-mvp\.css/);
  assert.match(refreshCss, /\.control-status-strip__refresh/);
  assert.match(refreshCss, /min-height:\s*48px/);
});
