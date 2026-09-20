import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const decisionCard = await readFile(new URL("../src/react-app/components/DecisionCard.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/react-app/decision-action-client.ts", import.meta.url), "utf8");

test("three-button UI does not hydrate or invoke continuation D1 transport", () => {
  assert.match(decisionCard, /OWNER_ACTIONS\.map/);
  assert.doesNotMatch(decisionCard, /readContinuationEligibility|PAUSE|RETRY_CI|NEEDS_CHANGES|LATER|OPEN_PR/);
  assert.doesNotMatch(client, /\/api\/control\/continuation|campaignId|revision|PAUSE|LATER|NEEDS_CHANGES|RETRY_CI/);
  assert.match(client, /\/api\/github\/owner-action/);
});
