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
async function clickFreshSelector(sessionId, selector) { await waitForBrowser(sessionId, `const element=document.querySelector(${JSON.stringify(selector)}); return element&&!element.disabled?true:null;`, `enabled action ${selector}`); const clicked = await execute(sessionId, `const element=document.querySelector(${JSON.stringify(selector)}); if(!element||element.disabled)return false; element.click(); return true;`); assert.equal(clicked, true, `No enabled clickable element for ${selector}`); }
async function setTextareaValue(sessionId, selector, value) { const updated = await execute(sessionId, `const element=document.querySelector(${JSON.stringify(selector)}); if(!(element instanceof HTMLTextAreaElement))return false; const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")?.set; if(!setter)return false; setter.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event("input",{bubbles:true})); return true;`); assert.equal(updated, true, `No textarea for ${selector}`); }
async function browserState() { const response = await fetch(`${APP_ORIGIN}/__browser/state`); assert.equal(response.ok, true); return response.json(); }
async function waitForDashboardRequestAfter(previousCount, label, timeoutMilliseconds = 10000) { assert.equal(Number.isSafeInteger(previousCount), true, `${label} previous dashboard request count is invalid`); const deadline = Date.now() + timeoutMilliseconds; let lastState = null; while (Date.now() < deadline) { lastState = await browserState(); if (Number.isSafeInteger(lastState?.dashboardRequests) && lastState.dashboardRequests > previousCount) return lastState; await sleep(100); } throw new Error(`${label} timed out; previous dashboard requests: ${previousCount}; last browser state: ${JSON.stringify(lastState)}`); }

async function runFixtureDeepLinkRegression(sessionId) {
  const decisionTarget = targetId("fixture-rpi5-controller");
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=fixture#${decisionTarget}`);
  const evidence = await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-666978747572652d727069352d636f6e74726f6c6c6572")}); if(!target||!document.body.innerText.includes("FIXTURE MODE"))return null; if(document.activeElement!==target)return null; const rect=target.getBoundingClientRect(); return {activeId:document.activeElement?.id??null,visible:rect.bottom>0&&rect.top<window.innerHeight,fixtureLabel:document.body.innerText.includes("Fixture fallback has no live mutation authority"),mutatingButtons:Array.from(target.querySelectorAll("button")).map((button)=>button.textContent?.trim()).filter((label)=>["Merge","Needs changes","Later"].includes(label))};`, "fixture deep-link focus");
  assert.equal(evidence.activeId, decisionTarget);
  assert.equal(evidence.visible, true);
  assert.equal(evidence.fixtureLabel, true);
  assert.deepEqual(evidence.mutatingButtons, []);
  console.log("browser regression: fixture deep-link focus and action suppression PASS");
}

async function runConfirmedActionRegression(sessionId) {
  const decisionTarget = targetId("browser-live-merge");
  await fetch(`${APP_ORIGIN}/__browser/reset`, { method: "POST" });
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=actions#${decisionTarget}`);
  const liveEvidence = await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-62726f777365722d6c6976652d6d65726765")}); if(!target||!document.body.innerText.includes("LIVE CONTROL"))return null; const labels=Array.from(target.querySelectorAll("button")).map((button)=>button.textContent?.trim()); if(!labels.includes("Needs changes")||!labels.includes("Merge"))return null; return {labels,hasMerge:labels.includes("Merge"),hasLater:labels.includes("Later")};`, "authoritative GitHub write controls");
  assert.equal(liveEvidence.hasMerge, true);
  assert.equal(liveEvidence.hasLater, true);
  const hydratedState = await browserState();
  assert.ok(hydratedState.reconcileRequests >= 1);

  await clickFreshSelector(sessionId, `#${decisionTarget} button[data-decision-action="MERGE"]`);
  const beforeMergeConfirm = await browserState();
  assert.equal(beforeMergeConfirm.actionRequests.length, 0);
  const mergeDialog = await waitForBrowser(sessionId, `const dialog=document.querySelector('[role="dialog"]'); const confirm=document.querySelector('button[data-confirm-action="MERGE"]'); if(!dialog||!confirm)return null; return {enabled:!confirm.disabled,summary:dialog.textContent.includes("squash-merge request")};`, "merge confirmation boundary");
  assert.equal(mergeDialog.enabled, true);
  assert.equal(mergeDialog.summary, true);
  const mergeCancelled = await execute(sessionId, `const buttons=Array.from(document.querySelectorAll('.decision-action-dialog__actions button')); const cancel=buttons.find((button)=>button.textContent?.trim()==="Cancel"); if(!cancel)return false; cancel.click(); return true;`);
  assert.equal(mergeCancelled, true);
  await waitForBrowser(sessionId, `return document.querySelector('[role="dialog"]')?null:true;`, "merge cancellation");

  await clickFreshSelector(sessionId, `#${decisionTarget} button[data-decision-action="NEEDS_CHANGES"]`);
  const beforeConfirm = await browserState();
  assert.equal(beforeConfirm.actionRequests.length, 0);
  const emptyNeedsDisabled = await waitForBrowser(sessionId, `const dialog=document.querySelector('[role="dialog"]'); const confirm=document.querySelector('button[data-confirm-action="NEEDS_CHANGES"]'); if(!dialog||!confirm)return null; return {disabled:confirm.disabled,summary:dialog.textContent.includes("REQUEST_CHANGES decision")};`, "needs-changes empty-message guard");
  assert.equal(emptyNeedsDisabled.disabled, true);
  assert.equal(emptyNeedsDisabled.summary, true);
  const reviewBody = "Please address the browser regression edge case.";
  await setTextareaValue(sessionId, ".decision-action-review textarea", reviewBody);
  await waitForBrowser(sessionId, `const confirm=document.querySelector('button[data-confirm-action="NEEDS_CHANGES"]'); return confirm&&!confirm.disabled?true:null;`, "enabled needs-changes confirmation");
  await execute(sessionId, `const confirm=document.querySelector('button[data-confirm-action="NEEDS_CHANGES"]'); confirm.click(); confirm.click(); return true;`);
  let actionEvidence = null;
  const actionDeadline = Date.now() + 10000;
  while (Date.now() < actionDeadline) {
    const state = await browserState();
    if (state.actionRequests.length === 1 && state.dashboardRequests >= 2 && state.reconcileRequests >= 2) { actionEvidence = state; break; }
    await sleep(100);
  }
  assert.ok(actionEvidence);
  assert.equal(actionEvidence.actionRequests.length, 1);
  assert.equal(actionEvidence.actionRequests[0].path, "/api/github/needs-changes");
  assert.equal(actionEvidence.actionRequests[0].body.repository, "rozkalnsandris/ops-workflows");
  assert.equal(actionEvidence.actionRequests[0].body.issueNumber, 421);
  assert.equal(actionEvidence.actionRequests[0].body.pullNumber, 999);
  assert.equal(actionEvidence.actionRequests[0].body.expectedHeadSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(actionEvidence.actionRequests[0].body.expectedMainSha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(actionEvidence.actionRequests[0].body.body, reviewBody);
  assert.match(actionEvidence.actionRequests[0].body.requestId, /^rcneeds_[A-Za-z0-9_]{32,}$/);
  const postRefresh = await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-62726f777365722d6c6976652d6d65726765")}); if(!target||!document.body.innerText.includes("LIVE CONTROL"))return null; const labels=Array.from(target.querySelectorAll("button")).map((button)=>button.textContent?.trim()); return labels.includes("Needs changes")&&labels.includes("Merge")?true:null;`, "post-action authoritative refresh");
  assert.equal(postRefresh, true);
  console.log("browser regression: authoritative Merge and Needs-changes controls PASS");
}

async function runStaleSnapshotRegression(sessionId) {
  const decisionTarget = targetId("browser-live-merge");
  await fetch(`${APP_ORIGIN}/__browser/reset`, { method: "POST" });
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=stale#${decisionTarget}`);
  await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-62726f777365722d6c6976652d6d65726765")}); if(!target||!document.body.innerText.includes("LIVE CONTROL"))return null; const labels=Array.from(target.querySelectorAll("button")).map((button)=>button.textContent?.trim()); return labels.includes("Needs changes")&&labels.includes("Merge")&&labels.includes("Later");`, "fresh authoritative GitHub write controls");
  const beforeRefresh = await browserState();
  assert.equal(Number.isSafeInteger(beforeRefresh.dashboardRequests), true);
  assert.ok(beforeRefresh.reconcileRequests >= 1);
  const armResponse = await fetch(`${APP_ORIGIN}/__browser/arm-stale`, { method: "POST" });
  assert.equal(armResponse.status, 204);
  await clickFreshSelector(sessionId, 'button[aria-label="Refresh live GitHub state"]');
  await waitForDashboardRequestAfter(beforeRefresh.dashboardRequests, "stale refresh fixture request");
  const staleEvidence = await waitForBrowser(sessionId, `const target=document.getElementById(${JSON.stringify("decision-62726f777365722d6c6976652d6d65726765")}); if(!target||!document.body.innerText.includes("LIVE · STALE"))return null; const buttonLabels=Array.from(target.querySelectorAll("button")).map((button)=>button.textContent?.trim()); const openPr=Array.from(target.querySelectorAll("a")).find((link)=>link.textContent?.trim()==="Open PR"); return {staleStatus:document.body.innerText.includes("Refresh failed · keeping Snapshot"),cachedDecisionVisible:target.textContent?.includes("Browser regression live decision")??false,mutatingButtons:buttonLabels.filter((label)=>["Merge","Needs changes","Later"].includes(label)),openPrHref:openPr?.href??null};`, "stale snapshot action suppression");
  const afterRefresh = await browserState();
  assert.equal(staleEvidence.staleStatus, true);
  assert.equal(staleEvidence.cachedDecisionVisible, true);
  assert.deepEqual(staleEvidence.mutatingButtons, []);
  assert.equal(staleEvidence.openPrHref, "https://github.com/rozkalnsandris/ops-workflows/pull/999");
  assert.equal(afterRefresh.reconcileRequests, beforeRefresh.reconcileRequests);
  console.log("browser regression: stale snapshot suppression PASS");
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
