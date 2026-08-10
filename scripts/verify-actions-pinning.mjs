import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workflowRoot = path.resolve(".github/workflows");
const fullSha = /^[0-9a-f]{40}$/i;
const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(target);
      continue;
    }
    if (!/\.ya?ml$/i.test(entry.name)) continue;

    const text = await readFile(target, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      const match = line.match(/\buses:\s*([^\s#]+)/);
      if (!match) continue;
      const action = match[1];
      if (action.startsWith("./")) continue;
      const at = action.lastIndexOf("@");
      const ref = at >= 0 ? action.slice(at + 1) : "";
      if (!fullSha.test(ref)) failures.push(`${path.relative(process.cwd(), target)}:${index + 1}: ${action}`);
    }
  }
}

await walk(workflowRoot);

if (failures.length > 0) {
  console.error("External GitHub Actions must be pinned to full 40-character commit SHAs:\n" + failures.join("\n"));
  process.exit(1);
}

console.log("Action pinning: PASS");
