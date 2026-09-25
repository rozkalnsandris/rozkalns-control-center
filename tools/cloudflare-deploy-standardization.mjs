import { resolve } from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath } from "node:url";

export const DEPLOY_IMPACT = Object.freeze({
  SOURCE_ONLY: "SOURCE_ONLY",
  ORDINARY_PUBLICATION: "ORDINARY_PUBLICATION",
  STRICT_LIVE: "STRICT_LIVE",
});

export const PATH_POLICY = Object.freeze({
  sourceOnlyFiles: Object.freeze([
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
  ]),
  sourceOnlyPrefixes: Object.freeze(["docs/", ".github/ISSUE_TEMPLATE/"]),
  ordinaryPublicationFiles: Object.freeze([
    ".nvmrc",
    "eslint.config.js",
    "index.html",
    "package-lock.json",
    "package.json",
    "tsconfig.app.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "tsconfig.test.json",
    "tsconfig.worker.json",
    "vite.config.ts",
  ]),
  ordinaryPublicationPrefixes: Object.freeze(["public/", "src/"]),
  strictLiveFiles: Object.freeze([
    "wrangler.d1-local-verify.jsonc",
    "wrangler.jsonc",
  ]),
  strictLivePrefixes: Object.freeze([
    ".github/",
    "migrations/",
    "scripts/",
    "tools/",
  ]),
});

const sourceOnlyFiles = new Set(PATH_POLICY.sourceOnlyFiles);
const ordinaryPublicationFiles = new Set(PATH_POLICY.ordinaryPublicationFiles);
const strictLiveFiles = new Set(PATH_POLICY.strictLiveFiles);

const hasPrefix = (path, prefixes) => prefixes.some((prefix) => path.startsWith(prefix));

function normalizePath(path) {
  return path.trim().replace(/^\.\//, "");
}

function classifySinglePath(path) {
  // Explicit source-only exceptions are checked before the broad .github/ strict
  // boundary. Everything else under .github/ remains strict by default.
  if (sourceOnlyFiles.has(path) || hasPrefix(path, PATH_POLICY.sourceOnlyPrefixes)) {
    return DEPLOY_IMPACT.SOURCE_ONLY;
  }
  if (strictLiveFiles.has(path) || hasPrefix(path, PATH_POLICY.strictLivePrefixes)) {
    return DEPLOY_IMPACT.STRICT_LIVE;
  }
  if (
    ordinaryPublicationFiles.has(path) ||
    hasPrefix(path, PATH_POLICY.ordinaryPublicationPrefixes)
  ) {
    return DEPLOY_IMPACT.ORDINARY_PUBLICATION;
  }
  return DEPLOY_IMPACT.STRICT_LIVE;
}

export function classifyDeployImpact(inputPaths) {
  const paths = [...new Set(inputPaths.map(normalizePath).filter(Boolean))];
  if (paths.length === 0) {
    return {
      impact: DEPLOY_IMPACT.STRICT_LIVE,
      reason: "EMPTY_OR_UNKNOWN_DIFF",
      paths: [],
    };
  }

  const classified = paths.map((path) => ({ path, impact: classifySinglePath(path) }));
  if (classified.some((entry) => entry.impact === DEPLOY_IMPACT.STRICT_LIVE)) {
    return {
      impact: DEPLOY_IMPACT.STRICT_LIVE,
      reason: "STRICT_OR_UNKNOWN_PATH_PRESENT",
      paths: classified,
    };
  }
  if (classified.some((entry) => entry.impact === DEPLOY_IMPACT.ORDINARY_PUBLICATION)) {
    return {
      impact: DEPLOY_IMPACT.ORDINARY_PUBLICATION,
      reason: "RUNTIME_OR_BUILD_PATH_PRESENT",
      paths: classified,
    };
  }
  return {
    impact: DEPLOY_IMPACT.SOURCE_ONLY,
    reason: "SOURCE_ONLY_PATHS",
    paths: classified,
  };
}

function printGithubOutputs(result) {
  stdout.write(`deploy_impact=${result.impact}\n`);
  stdout.write(`reason=${result.reason}\n`);
}

const invokedPath = argv[1] ? resolve(argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  printGithubOutputs(classifyDeployImpact(argv.slice(2)));
}
