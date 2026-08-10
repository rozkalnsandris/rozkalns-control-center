import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "dist", ".tmp-tests", ".wrangler", ".wrangler-dry-run"]);
const forbiddenNames = [/^\.env($|\.)/i, /\.pem$/i, /\.key$/i, /^id_rsa$/i, /^id_ed25519$/i];
const allowedEnvExamples = new Set([".env.example", ".dev.vars.example"]);
const forbiddenContent = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/
];
const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const relative = path.relative(root, target);

    if (entry.isDirectory()) {
      await walk(target);
      continue;
    }

    if (!allowedEnvExamples.has(entry.name) && forbiddenNames.some((pattern) => pattern.test(entry.name))) {
      failures.push(`${relative}: forbidden secret-bearing filename`);
      continue;
    }

    let text;
    try {
      text = await readFile(target, "utf8");
    } catch {
      continue;
    }

    for (const pattern of forbiddenContent) {
      if (pattern.test(text)) failures.push(`${relative}: secret-like content matched ${pattern}`);
    }
  }
}

await walk(root);

if (failures.length > 0) {
  console.error("Public-repository safety check failed:\n" + failures.join("\n"));
  process.exit(1);
}

console.log("Public-repository safety: PASS");
