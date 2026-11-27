import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import process from "node:process";

/**
 * Checks what `npm pack` would publish. Run after `pnpm build`: the files the
 * package.json "exports" point at live in dist/ and src/.
 *
 * Fails when a required file is missing or empty, when anything outside the
 * expected layout would ship (contributor or internal docs, non-code files in
 * dist/ or src/), or when llms.txt is missing its agent notes and ecosystem link
 * or links outside the tarball.
 * Test files and the privacy scan are covered by check-package-contents.sh.
 */

const DOCS = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "llms.txt",
  "docs/API.md",
];

/** The only top-level entries the tarball may contain. */
const TOP_LEVEL = new Set(["package.json", "dist", "src", "docs", ...DOCS]);

/** Allowed file types inside the code directories. */
const CODE_FILES = {
  dist: /\.(js|d\.ts|js\.map|d\.ts\.map)$/,
  src: /\.ts$/,
};

const ECOSYSTEM_LINK = "](https://oss.vllnt.com/llms.txt)";

const REPO_BLOB =
  /^https:\/\/github\.com\/vllnt\/convex-idempotency\/blob\/[^/]+\/(.+)$/;

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
  const top = path.split("/")[0];
  const codePattern = CODE_FILES[top];
  if (!TOP_LEVEL.has(top)) {
    problems.push(`must not ship: ${path}`);
  } else if (codePattern !== undefined && !codePattern.test(path)) {
    problems.push(`must not ship (not a code file): ${path}`);
  } else if (top === "docs" && !DOCS.includes(path)) {
    problems.push(`must not ship (not a published doc): ${path}`);
  }
}

if (packed.has("llms.txt")) {
  const llms = readFileSync("llms.txt", "utf8");
  for (const heading of ["## For coding agents", "## Ecosystem"]) {
    if (!llms.includes(`\n${heading}\n`))
      problems.push(`llms.txt lacks "${heading}"`);
  }
  const ecosystem = llms.split("\n## Ecosystem\n")[1]?.split("\n## ")[0] ?? "";
  if (!ecosystem.includes(ECOSYSTEM_LINK)) {
    problems.push(
      "llms.txt Ecosystem lacks the https://oss.vllnt.com/llms.txt link",
    );
  }
  for (const [, link] of llms.matchAll(/\]\(([^)]+)\)/g)) {
    const target = link.split("#")[0];
    const repoPath = REPO_BLOB.exec(target)?.[1];
    if (repoPath !== undefined && packed.has(repoPath)) {
      problems.push(`llms.txt links ${repoPath} on GitHub; use ./${repoPath}`);
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      if (!target.startsWith("./")) {
        problems.push(`llms.txt relative link must start with ./: ${target}`);
      } else if (!packed.has(posix.normalize(target))) {
        problems.push(`llms.txt link not in tarball: ${target}`);
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}
console.log(
  `OK    package: ${packed.size} files, ${required.size} required present`,
);
