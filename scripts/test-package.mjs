import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import process from "node:process";

/**
 * Checks what `npm pack` would publish. Run after `pnpm build`: the files the
 * package.json "exports" point at live in dist/ and src/.
 *
 * Fails when a required file is missing or empty, when a file that must not ship
 * is present, or when an llms.txt link does not resolve inside the tarball.
 */

const DOCS = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "llms.txt",
  "docs/API.md",
];

/** Files that may sit at the tarball root. Anything else there is unexpected. */
const ROOT_FILES = new Set(["package.json", ...DOCS.filter((f) => !f.includes("/"))]);

/** Paths that must never ship, with the reason reported on failure. */
const FORBIDDEN = [
  [/(^|\/)(AGENTS|CLAUDE)\.md$/, "contributor agent instructions"],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, "test or spec file"],
  [/(^|\/)__tests__\//, "test directory"],
  [/^(example|scripts|\.github)\//, "repository tooling"],
];

const REPO_BLOB = /^https:\/\/github\.com\/vllnt\/convex-idempotency\/blob\/[^/]+\/(.+)$/;

/** @param {unknown} value @returns {string[]} every string leaf of an "exports" map */
function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(exportTargets);
}

/** @returns {Map<string, number>} packed path to size in bytes */
function packedFiles() {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const [pack] = JSON.parse(output);
  return new Map(pack.files.map((file) => [file.path, file.size]));
}

/** @param {string} markdown @returns {string[]} link targets without fragments */
function linkTargets(markdown) {
  return [...markdown.matchAll(/\]\(([^)]+)\)/g)]
    .map(([, target]) => target.split("#")[0])
    .filter(Boolean);
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const packed = packedFiles();
/** @type {string[]} */
const problems = [];

const required = new Set([
  "package.json",
  ...DOCS,
  ...exportTargets(manifest.exports).map((target) => posix.normalize(target)),
]);
for (const path of required) {
  if (!packed.has(path)) problems.push(`missing from tarball: ${path}`);
  else if (packed.get(path) === 0) problems.push(`empty in tarball: ${path}`);
}

for (const path of packed.keys()) {
  for (const [pattern, reason] of FORBIDDEN) {
    if (pattern.test(path)) problems.push(`must not ship (${reason}): ${path}`);
  }
  if (!path.includes("/") && !ROOT_FILES.has(path)) {
    problems.push(`unexpected root file: ${path}`);
  }
  if (path.startsWith("docs/") && path !== "docs/API.md") {
    problems.push(`unexpected doc: ${path}`);
  }
}

if (packed.has("llms.txt")) {
  for (const target of linkTargets(readFileSync("llms.txt", "utf8"))) {
    const repoPath = REPO_BLOB.exec(target)?.[1];
    if (repoPath !== undefined) {
      if (packed.has(repoPath)) {
        problems.push(`llms.txt links ${repoPath} on GitHub main; use ./${repoPath}`);
      }
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      const path = posix.normalize(target);
      if (!packed.has(path)) problems.push(`llms.txt link not in tarball: ${target}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}
console.log(`OK    package: ${packed.size} files, ${required.size} required present`);
