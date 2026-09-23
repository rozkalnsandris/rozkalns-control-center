import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const { fetch } = globalThis;
const APP_ORIGIN = "http://127.0.0.1:4173";
const DRIVER_ORIGIN = "http://127.0.0.1:9515";

function sleep(milliseconds) { return delay(milliseconds); }
function targetId(decisionId) { return `decision-${Buffer.from(decisionId, "utf8").toString("hex")}`; }
function captureProcessOutput(child) { let output = ""; const append = (chunk) => { output += chunk.toString(); if (output.length > 12000) output = output.slice(-12000); }; child.stdout?.on("data", append); child.stderr?.on("data", append); return () => output; }
async function waitForHttp(url, label, timeoutMilliseconds = 15000) { const deadline = Date.now() + timeoutMilliseconds; let lastError = null; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return; lastError = new Error(`${label} returned HTTP ${response.status}`); } catch (error) { lastError = error; } await sleep(100); } throw new Error(`${label} did not become ready: ${String(lastError)}`); }
async function webdriver(method, path, body) { const response = await fetch(`${DRIVER_ORIGIN}${path}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const payload = await response.json(); if (!response.ok || payload?.value?.error) throw new Error(`WebDriver ${method} ${path} failed: ${JSON.stringify(payload)}`); return payload.value; }
async function execute(sessionId, script, args = []) { return webdriver("POST", `/session/${sessionId}/execute/sync`, { script, args }); }
async function waitForBrowser(sessionId, script, label, timeoutMilliseconds = 10000) { const deadline = Date.now() + timeoutMilliseconds; let lastValue = null; while (Date.now() < deadline) { lastValue = await execute(sessionId, script); if (lastValue) return lastValue; await sleep(100); } throw new Error(`${label} timed out; last browser value: ${JSON.stringify(lastValue)}`); }
async function navigate(sessionId, url) { await webdriver("POST", `/session/${sessionId}/url`, { url }); }
async function clickFreshSelector(sessionId, selector) { await waitForBrowser(sessionId, `const element=document.querySelector(${JSON.stringify(selector)}); return element&&!element.disabled&&element.getAttribute("aria-disabled")!=="true"?true:null;`, `enabled action ${selector}`); const clicked = await execute(sessionId, `const element=document.querySelector(${JSON.stringify(selector)}); if(!element||element.disabled||element.getAttribute("aria-disabled")==="true")return false; element.click(); return true;`); assert.equal(clicked, true, `No enabled clickable element for ${selector}`); }
async function browserState() { const response = await fetch(`${APP_ORIGIN}/__browser/state`); assert.equal(response.ok, true); return response.json(); }
async function waitForDashboardRequestAfter(previousCount, label, timeoutMilliseconds = 10000) { assert.equal(Number.isSafeInteger(previousCount), true, `${label} previous dashboard request count is invalid`); const deadline = Date.now() + timeoutMilliseconds; let lastState = null; while (Date.now() < deadline) { lastState = await browserState(); if (Number.isSafeInteger(lastState?.dashboardRequests) && lastState.dashboardRequests > previousCount) return lastState; await sleep(100); } throw new Error(`${label} timed out; previous dashboard requests: ${previousCount}; last browser state: ${JSON.stringify(lastState)}`); }

async function runFixtureDeepLinkRegression(sessionId) {
  const decisionTarget = targetId("fixture-rpi5-controller");
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=fixture#${decisionTarget}`);
  const evidence = await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-666978747572652d727069352d636f6e74726f6c6c6572")}); if(!target||!document.body.innerText.includes("FIXTURE MODE"))return null; if(document.activeElement!==target)return null; const rect=target.getBoundingClientRect(); return {activeId:document.activeElement?.id??null,visible:rect.bottom>0&&rect.top<window.innerHeight,fixtureLabel:document.body.innerText.includes("Fixture fallback has no live mutation authority"),mutatingButtons:Array.from(target.querySelectorAll('button:not([aria-disabled="true"])')).map((button)=>button.textContent?.trim()).filter((label)=>["Merge","Live","Continue"].includes(label))};`, "fixture deep-link focus");
  assert.equal(evidence.activeId, decisionTarget);
  assert.equal(evidence.visible, true);
  assert.equal(evidence.fixtureLabel, true);
  assert.deepEqual(evidence.mutatingButtons, []);
  const panel = await execute(sessionId, `const card=document.getElementById(${JSON.stringify(decisionTarget)}); return { actions: Array.from(card.querySelectorAll('[data-decision-action]')).map((item)=>item.dataset.decisionAction), reasons:card.querySelectorAll('.action-panel__entry small').length, overflow:document.documentElement.scrollWidth>window.innerWidth, touch:Array.from(card.querySelectorAll('[data-decision-action]')).every((item)=>item.getBoundingClientRect().height>=48) };`);
  assert.deepEqual(panel.actions, ["MERGE", "LIVE", "CONTINUE"]);
  assert.ok(panel.reasons >= 3);
  assert.equal(panel.overflow, false);
  assert.equal(panel.touch, true);
  console.log("browser regression: fixture deep-link focus and three-button action suppression PASS");
}

async function runConfirmedActionRegression(sessionId) {
  const decisionTarget = targetId("browser-live-merge");
  await fetch(`${APP_ORIGIN}/__browser/reset`, { method: "POST" });
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=actions#${decisionTarget}`);
  const liveEvidence = await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-62726f777365722d6c6976652d6d65726765")}); if(!target||!document.body.innerText.includes("LIVE CONTROL"))return null; const actions=Array.from(target.querySelectorAll('[data-decision-action]')).map((button)=>({action:button.dataset.decisionAction,label:button.textContent?.trim(),disabled:button.getAttribute("aria-disabled")==="true"})); const merge=actions.find((entry)=>entry.action==="MERGE"); const live=actions.find((entry)=>entry.action==="LIVE"); const cont=actions.find((entry)=>entry.action==="CONTINUE"); if(!merge||merge.disabled||!live||!live.disabled||!cont||!cont.disabled)return null; return {actions,reasons:target.querySelectorAll('.action-panel__entry small').length};`, "three-button authoritative controls");
  assert.deepEqual(liveEvidence.actions.map((entry)=>entry.action), ["MERGE", "LIVE", "CONTINUE"]);
  assert.ok(liveEvidence.reasons >= 2);
  const hydratedState = await browserState();
  assert.ok(hydratedState.reconcileRequests >= 1);
  assert.deepEqual(hydratedState.actionRequests, []);

  await clickFreshSelector(sessionId, `#${decisionTarget} button[data-decision-action="MERGE"]`);
  const beforeMergeConfirm = await browserState();
  assert.equal(beforeMergeConfirm.actionRequests.length, 0);
  const mergeDialog = await waitForBrowser(sessionId, `const dialog=document.querySelector('[role="dialog"]'); const confirm=document.querySelector('button[data-confirm-action="MERGE"]'); if(!dialog||!confirm)return null; return {enabled:!confirm.disabled,summary:dialog.textContent.includes("squash-merge request")};`, "merge confirmation boundary");
  assert.equal(mergeDialog.enabled, true);
  assert.equal(mergeDialog.summary, true);
  const mergeCancelled = await execute(sessionId, `const buttons=Array.from(document.querySelectorAll('.decision-action-dialog__actions button')); const cancel=buttons.find((button)=>button.textContent?.trim()==="Cancel"); if(!cancel)return false; cancel.click(); return true;`);
  assert.equal(mergeCancelled, true);
  await waitForBrowser(sessionId, `return document.querySelector('[role="dialog"]')?null:true;`, "merge cancellation");
  assert.deepEqual((await browserState()).actionRequests, []);
  console.log("browser regression: authoritative Merge with fail-closed Live and Continue PASS");
}

async function runStaleSnapshotRegression(sessionId) {
  const decisionTarget = targetId("browser-live-merge");
  await fetch(`${APP_ORIGIN}/__browser/reset`, { method: "POST" });
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=stale#${decisionTarget}`);
  await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-62726f777365722d6c6976652d6d65726765")}); if(!target||!document.body.innerText.includes("LIVE CONTROL"))return null; const actions=Array.from(target.querySelectorAll('[data-decision-action]')).map((button)=>({action:button.dataset.decisionAction,disabled:button.getAttribute("aria-disabled")==="true"})); const merge=actions.find((entry)=>entry.action==="MERGE"); return actions.length===3&&merge&&!merge.disabled?true:null;`, "fresh three-button controls");
  const beforeRefresh = await browserState();
  assert.equal(Number.isSafeInteger(beforeRefresh.dashboardRequests), true);
  assert.ok(beforeRefresh.reconcileRequests >= 1);
  const armResponse = await fetch(`${APP_ORIGIN}/__browser/arm-stale`, { method: "POST" });
  assert.equal(armResponse.status, 204);
  await clickFreshSelector(sessionId, 'button[aria-label="Refresh live GitHub state"]');
  await waitForDashboardRequestAfter(beforeRefresh.dashboardRequests, "stale refresh fixture request");
  const staleEvidence = await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-62726f777365722d6c6976652d6d65726765")}); if(!target||!document.body.innerText.includes("LIVE · STALE"))return null; const actions=Array.from(target.querySelectorAll('[data-decision-action]')).map((button)=>({action:button.dataset.decisionAction,disabled:button.getAttribute("aria-disabled")==="true"})); return {staleStatus:document.body.innerText.includes("Live service error · keeping Snapshot"),cachedDecisionVisible:target.textContent?.includes("Browser regression live decision")??false,actions};`, "stale snapshot action suppression");
  const afterRefresh = await browserState();
  assert.equal(staleEvidence.staleStatus, true);
  assert.equal(staleEvidence.cachedDecisionVisible, true);
  assert.deepEqual(staleEvidence.actions.map((entry)=>entry.action), ["MERGE", "LIVE", "CONTINUE"]);
  assert.equal(staleEvidence.actions.every((entry)=>entry.disabled), true);
  assert.equal(afterRefresh.reconcileRequests, beforeRefresh.reconcileRequests);
  console.log("browser regression: stale snapshot three-button suppression PASS");
}

async function runAgedSnapshotRegression(sessionId) {
  const decisionTarget = targetId("browser-live-merge");
  await fetch(`${APP_ORIGIN}/__browser/reset`, { method: "POST" });
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=aged#${decisionTarget}`);
  const evidence = await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-62726f777365722d6c6976652d6d65726765")}); if(!target||!document.body.innerText.includes("LIVE · STALE"))return null; const actions=Array.from(target.querySelectorAll('[data-decision-action]')).map((button)=>({action:button.dataset.decisionAction,disabled:button.getAttribute("aria-disabled")==="true"})); return {freshness:document.body.innerText.includes("five-minute freshness limit"),cachedDecisionVisible:target.textContent?.includes("Browser regression live decision")??false,actions};`, "aged snapshot classification");
  const state = await browserState();
  assert.equal(evidence.freshness, true);
  assert.equal(evidence.cachedDecisionVisible, true);
  assert.deepEqual(evidence.actions.map((entry)=>entry.action), ["MERGE", "LIVE", "CONTINUE"]);
  assert.equal(evidence.actions.every((entry)=>entry.disabled), true);
  const panel = await execute(sessionId, `const card=document.getElementById(${JSON.stringify(decisionTarget)}); return { reasons:card.querySelectorAll('.action-panel__entry small').length, overflow:document.documentElement.scrollWidth>window.innerWidth, touch:Array.from(card.querySelectorAll('[data-decision-action]')).every((item)=>item.getBoundingClientRect().height>=48) };`);
  assert.ok(panel.reasons >= 3);
  assert.equal(panel.overflow, false);
  assert.equal(panel.touch, true);
  assert.equal(state.reconcileRequests, 0);
  console.log("browser regression: over-age snapshot three-button suppression PASS");
}

async function runOperationalObservabilityRegression(sessionId) {
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=actions`);
  const healthy = await waitForBrowser(sessionId, `const card=document.querySelector('.system-health'); if(!card||!card.textContent.includes('HEALTHY'))return null; return {counts:card.textContent.includes('Non-terminal')&&card.textContent.includes('Dead-lettered'),observed:card.textContent.includes('Observed'),rateLimit:card.textContent.includes('GitHub API')&&card.textContent.includes('4500'),mutationControls:Array.from(card.querySelectorAll('button')).length};`, "healthy reconciliation evidence");
  assert.equal(healthy.counts, true);
  assert.equal(healthy.observed, true);
  assert.equal(healthy.rateLimit, true);
  assert.equal(healthy.mutationControls, 0);

  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=observability-failure`);
  const unavailable = await waitForBrowser(sessionId, `const card=document.querySelector('.system-health'); if(!card||!card.textContent.includes('Delivery health unavailable'))return null; const status=card.querySelector('.status-pill')?.textContent?.trim(); return {attention:status==='ATTENTION',healthy:status==='HEALTHY',mutationControls:Array.from(card.querySelectorAll('button')).length};`, "failed reconciliation observability");
  assert.equal(unavailable.attention, true);
  assert.equal(unavailable.healthy, false);
  assert.equal(unavailable.mutationControls, 0);
  console.log("browser regression: reconciliation observability fail-closed health PASS");
}

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "tests/browser/vite.config.mjs", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
const chromeDriver = spawn(process.env.CHROMEDRIVER ?? "chromedriver", ["--port=9515", "--log-level=WARNING"], { stdio: ["ignore", "pipe", "pipe"] });
const viteOutput = captureProcessOutput(vite);
const chromeDriverOutput = captureProcessOutput(chromeDriver);
let sessionId = null;

try {
  await Promise.all([waitForHttp(APP_ORIGIN, "Vite browser regression server"), waitForHttp(`${DRIVER_ORIGIN}/status`, "ChromeDriver")]);
  const session = await webdriver("POST", "/session", { capabilities: { alwaysMatch: { browserName: "chrome", "goog:chromeOptions": { args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=390,844"] } } } });
  sessionId = session.sessionId;
  if (!sessionId) throw new Error(`ChromeDriver returned no session id: ${JSON.stringify(session)}`);
  await runFixtureDeepLinkRegression(sessionId);
  await runConfirmedActionRegression(sessionId);
  await runStaleSnapshotRegression(sessionId);
  await runAgedSnapshotRegression(sessionId);
  await runOperationalObservabilityRegression(sessionId);
} catch (error) {
  console.error("browser regression failed");
  console.error(error);
  console.error("--- vite output ---");
  console.error(viteOutput());
  console.error("--- chromedriver output ---");
  console.error(chromeDriverOutput());
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try { await webdriver("DELETE", `/session/${sessionId}`); } catch { /* Best-effort session cleanup; the driver may already have closed it. */ }
  }
  vite.kill("SIGTERM");
  chromeDriver.kill("SIGTERM");
}
