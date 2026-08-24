import { resolve } from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const DOC_FILES = new Set([
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
]);
const DOC_PREFIXES = ["docs/", ".github/ISSUE_TEMPLATE/"];

const isDocumentationPath = (path) =>
  DOC_FILES.has(path) || DOC_PREFIXES.some((prefix) => path.startsWith(prefix));

export function classifyPaths(inputPaths) {
  const paths = [...new Set(inputPaths.map((path) => path.trim()).filter(Boolean))];

  // Missing or ambiguous diff evidence always fails open to full CI.
  if (paths.length === 0) {
    return { mode: "full", docsOnly: false, full: true };
  }

  if (paths.every(isDocumentationPath)) {
    return { mode: "docs-only", docsOnly: true, full: false };
  }

  // Source, workflows, dependencies, tests, scripts, tools, migrations,
  // Wrangler config and unknown paths all receive the complete validation lane.
  return { mode: "full", docsOnly: false, full: true };
}

function printGithubOutputs(scope) {
  stdout.write(`mode=${scope.mode}\n`);
  stdout.write(`docs_only=${scope.docsOnly}\n`);
  stdout.write(`full=${scope.full}\n`);
}

const invokedPath = argv[1] ? resolve(argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  printGithubOutputs(classifyPaths(argv.slice(2)));
}
