import { spawnSync } from "node:child_process";

const SHA1 = /^[0-9a-f]{40}$/;

export function checkGitAncestor(ancestorSha, descendantSha, options = {}) {
  if (!SHA1.test(ancestorSha) || !SHA1.test(descendantSha)) {
    return { ok: false, reason: "INVALID_SHA" };
  }

  const result = spawnSync(
    options.git ?? "git",
    ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
    {
      cwd: options.cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      env: options.env ?? process.env,
    },
  );

  if (result.error) return { ok: false, reason: "CHECK_FAILED" };
  if (result.status === 0) return { ok: true, reason: "ANCESTOR" };
  if (result.status === 1) return { ok: false, reason: "NOT_ANCESTOR" };
  return { ok: false, reason: "CHECK_FAILED" };
}
