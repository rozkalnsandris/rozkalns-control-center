import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const { fetch } = globalThis;
const APP_ORIGIN = "http://127.0.0.1:4173";
const DRIVER_ORIGIN = "http://127.0.0.1:9515";
const WEBDRIVER_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

function sleep(milliseconds) {
  return delay(milliseconds);
}

function targetId(decisionId) {
  return `decision-${Buffer.from(decisionId, "utf8").toString("hex")}`;
}

function captureProcessOutput(child) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString();
    if (output.length > 12000) output = output.slice(-12000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
}

async function waitForHttp(url, label, timeoutMilliseconds = 15000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }

  throw new Error(`${label} did not become ready: ${String(lastError)}`);
}

async function webdriver(method, path, body) {
  const response = await fetch(`${DRIVER_ORIGIN}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();

  if (!response.ok || payload?.value?.error) {
    throw new Error(`WebDriver ${method} ${path} failed: ${JSON.stringify(payload)}`);
  }

  return payload.value;
}

async function execute(sessionId, script, args = []) {
  return webdriver("POST", `/session/${sessionId}/execute/sync`, { script, args });
}

async function waitForBrowser(sessionId, script, label, timeoutMilliseconds = 10000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastValue = null;

  while (Date.now() < deadline) {
    lastValue = await execute(sessionId, script);
    if (lastValue) return lastValue;
    await sleep(100);
  }

  throw new Error(`${label} timed out; last browser value: ${JSON.stringify(lastValue)}`);
}

async function navigate(sessionId, url) {
  await webdriver("POST", `/session/${sessionId}/url`, { url });
}

async function findElement(sessionId, using, value) {
  const element = await webdriver("POST", `/session/${sessionId}/element`, { using, value });
  const elementId = element?.[WEBDRIVER_ELEMENT_KEY];
  if (!elementId) throw new Error(`WebDriver element lookup returned no element id for ${value}`);
  return elementId;
}

async function clickElement(sessionId, elementId) {
  await webdriver("POST", `/session/${sessionId}/element/${elementId}/click`, {});
}

async function runFixtureDeepLinkRegression(sessionId) {
  const decisionTarget = targetId("fixture-rpi5-controller");
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=fixture#${decisionTarget}`);

  const evidence = await waitForBrowser(
    sessionId,
    `
      const target = document.getElementById(${JSON.stringify(decisionTarget)});
      if (!target || !document.body.innerText.includes("FIXTURE MODE")) return null;
      if (document.activeElement !== target) return null;
      const rect = target.getBoundingClientRect();
      return {
        activeId: document.activeElement?.id ?? null,
        visible: rect.bottom > 0 && rect.top < window.innerHeight,
        fixtureLabel: document.body.innerText.includes("Fixture fallback only"),
        mutatingButtons: Array.from(target.querySelectorAll("button"))
          .map((button) => button.textContent?.trim())
          .filter((label) => ["Merge", "Needs changes", "Later"].includes(label)),
      };
    `,
    "fixture deep-link focus",
  );

  assert.equal(evidence.activeId, decisionTarget);
  assert.equal(evidence.visible, true, "deep-linked decision must be scrolled into the viewport");
  assert.equal(evidence.fixtureLabel, true, "fixture fallback must be visibly identified as non-live authority");
  assert.deepEqual(evidence.mutatingButtons, [], "fixture authority must suppress mutating actions");

  console.log("browser regression: fixture deep-link focus and action suppression PASS");
}

async function runStaleSnapshotRegression(sessionId) {
  const decisionTarget = targetId("browser-live-merge");
  await fetch(`${APP_ORIGIN}/__browser/reset`, { method: "POST" });
  await navigate(sessionId, `${APP_ORIGIN}/?browserScenario=stale#${decisionTarget}`);

  const freshEvidence = await waitForBrowser(
    sessionId,
    `
      const target = document.getElementById(${JSON.stringify(decisionTarget)});
      if (!target || !document.body.innerText.includes("LIVE READ-ONLY")) return null;
      const labels = Array.from(target.querySelectorAll("button")).map((button) => button.textContent?.trim());
      return {
        hasMerge: labels.includes("Merge"),
        hasNeedsChanges: labels.includes("Needs changes"),
        hasLater: labels.includes("Later"),
      };
    `,
    "fresh live decision controls",
  );

  assert.equal(freshEvidence.hasMerge, true);
  assert.equal(freshEvidence.hasNeedsChanges, true);
  assert.equal(freshEvidence.hasLater, true);

  const armResponse = await fetch(`${APP_ORIGIN}/__browser/arm-stale`, { method: "POST" });
  assert.equal(armResponse.status, 204);

  const refreshButton = await findElement(sessionId, "css selector", 'button[aria-label="Refresh live GitHub state"]');
  await clickElement(sessionId, refreshButton);

  const staleEvidence = await waitForBrowser(
    sessionId,
    `
      const target = document.getElementById(${JSON.stringify(decisionTarget)});
      if (!target || !document.body.innerText.includes("LIVE · STALE")) return null;
      const buttonLabels = Array.from(target.querySelectorAll("button")).map((button) => button.textContent?.trim());
      const openPr = Array.from(target.querySelectorAll("a")).find((link) => link.textContent?.trim() === "Open PR");
      return {
        staleStatus: document.body.innerText.includes("Refresh failed · keeping Snapshot"),
        cachedDecisionVisible: target.textContent?.includes("Browser regression live decision") ?? false,
        mutatingButtons: buttonLabels.filter((label) => ["Merge", "Needs changes", "Later"].includes(label)),
        openPrHref: openPr?.href ?? null,
      };
    `,
    "stale snapshot action suppression",
  );

  assert.equal(staleEvidence.staleStatus, true, "refresh failure must visibly mark the retained snapshot stale");
  assert.equal(staleEvidence.cachedDecisionVisible, true, "stale UI should retain the prior snapshot as evidence");
  assert.deepEqual(staleEvidence.mutatingButtons, [], "stale authority must suppress cached mutating actions");
  assert.equal(
    staleEvidence.openPrHref,
    "https://github.com/rozkalnsandris/rozkalns-control-center/pull/999",
    "non-mutating PR navigation may remain available",
  );

  console.log("browser regression: stale snapshot suppression PASS");
}

const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--config",
    "tests/browser/vite.config.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    "4173",
    "--strictPort",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const chromeDriver = spawn(process.env.CHROMEDRIVER ?? "chromedriver", ["--port=9515", "--log-level=WARNING"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const viteOutput = captureProcessOutput(vite);
const chromeDriverOutput = captureProcessOutput(chromeDriver);

let sessionId = null;

try {
  await Promise.all([
    waitForHttp(APP_ORIGIN, "Vite browser regression server"),
    waitForHttp(`${DRIVER_ORIGIN}/status`, "ChromeDriver"),
  ]);

  const session = await webdriver("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "chrome",
        "goog:chromeOptions": {
          args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=390,844"],
        },
      },
    },
  });
  sessionId = session.sessionId;
  if (!sessionId) throw new Error(`ChromeDriver returned no session id: ${JSON.stringify(session)}`);

  await runFixtureDeepLinkRegression(sessionId);
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
    try {
      await webdriver("DELETE", `/session/${sessionId}`);
    } catch {
      // Preserve the original test result; process termination below is sufficient cleanup.
    }
  }
  vite.kill("SIGTERM");
  chromeDriver.kill("SIGTERM");
}
