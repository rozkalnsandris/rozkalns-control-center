import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const decisionCard = await readFile(resolve(process.cwd(), "src/react-app/components/DecisionCard.tsx"), "utf8");
const client = await readFile(resolve(process.cwd(), "src/react-app/decision-action-client.ts"), "utf8");

test("three-button UI does not hydrate or invoke continuation D1 transport", () => {
  assert.match(decisionCard, /OWNER_ACTIONS\.map/);
  assert.doesNotMatch(decisionCard, /readContinuationEligibility|PAUSE|RETRY_CI|NEEDS_CHANGES|LATER|OPEN_PR/);
  assert.doesNotMatch(client, /\/api\/control\/continuation|campaignId|revision|PAUSE|LATER|NEEDS_CHANGES|RETRY_CI/);
  assert.match(client, /\/api\/github\/owner-action/);
});
