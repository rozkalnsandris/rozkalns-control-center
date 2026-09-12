import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const HELPER_PATH = "scripts/phase5-git-provenance.mjs";

type Result = { ok: boolean; reason: string };

function run(command: string, args: string[], cwd: string): string {
  const child = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout.trim();
}

function check(ancestorSha: string, descendantSha: string, cwd: string): Result {
  const moduleUrl = pathToFileURL(resolve(HELPER_PATH)).href;
  const program = [
    `import { checkGitAncestor } from ${JSON.stringify(moduleUrl)};`,
    "const result = checkGitAncestor(process.env.ANCESTOR_SHA, process.env.DESCENDANT_SHA, { cwd: process.env.TEST_REPO });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    env: { ...process.env, ANCESTOR_SHA: ancestorSha, DESCENDANT_SHA: descendantSha, TEST_REPO: cwd },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout) as Result;
}

test("Git provenance accepts equal/ancestor SHAs and rejects diverged or malformed SHAs", () => {
  const directory = mkdtempSync(join(tmpdir(), "phase5-git-provenance-"));
  try {
    run("git", ["init", "-b", "main"], directory);
    run("git", ["config", "user.name", "Phase5 Test"], directory);
    run("git", ["config", "user.email", "phase5@example.invalid"], directory);

    writeFileSync(join(directory, "state.txt"), "one\n");
    run("git", ["add", "state.txt"], directory);
    run("git", ["commit", "-m", "one"], directory);
    const provisionSha = run("git", ["rev-parse", "HEAD"], directory);

    writeFileSync(join(directory, "state.txt"), "two\n");
    run("git", ["commit", "-am", "two"], directory);
    const approvedSha = run("git", ["rev-parse", "HEAD"], directory);

    run("git", ["switch", "-c", "side", provisionSha], directory);
    writeFileSync(join(directory, "side.txt"), "side\n");
    run("git", ["add", "side.txt"], directory);
    run("git", ["commit", "-m", "side"], directory);
    const divergedSha = run("git", ["rev-parse", "HEAD"], directory);

    assert.deepEqual(check(provisionSha, approvedSha, directory), { ok: true, reason: "ANCESTOR" });
    assert.deepEqual(check(approvedSha, approvedSha, directory), { ok: true, reason: "ANCESTOR" });
    assert.deepEqual(check(divergedSha, approvedSha, directory), { ok: false, reason: "NOT_ANCESTOR" });
    assert.deepEqual(check("not-a-sha", approvedSha, directory), { ok: false, reason: "INVALID_SHA" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
