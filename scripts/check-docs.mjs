import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import process from "node:process";

/**
 * Checks that the agent-facing docs match the package. Run after `pnpm build`
 * (it reads dist/ and type-checks the README examples against it).
 *
 * README: required sections in order, install and first example in the first
 * 40 lines, badges after the Quick start, tagged and complete code blocks, the
 * exact Links section and footer, the convex peer range under Compatibility,
 * every public export and every error code documented, and every
 * TypeScript example compiling against the built package.
 * Shipped docs: relative links and #anchors resolve, the llms.txt facts and
 * ecosystem block are present, and the retired vllnt ".ai" domain appears nowhere.
 * Exports: each one has a TSDoc summary, and the main entry carries the
 * package-page `@see` link.
 */

const NAME = "convex-idempotency";
const PACKAGE = `@vllnt/${NAME}`;
const PAGE = `https://oss.vllnt.com/packages/${NAME}`;

const SECTIONS = [
  "For coding agents",
  "When to use",
  "Install",
  "Quick start",
  "API",
  "Common tasks",
  "Errors and fixes",
  "Limits and gotchas",
  "Compatibility",
  "Testing",
  "Security",
  "Related packages",
  "Contributing",
  "Links",
  "License",
  "Author",
];

const FOOTER = [
  "---",
  "",
  `Part of [vllnt open source](https://oss.vllnt.com) · [Package page](${PAGE}) · [vllnt.com](https://vllnt.com) · Built by [bntvllnt](https://bntvllnt.com)`,
];

const LINKS = [
  "## Links",
  "",
  `- Docs and changelog: [oss.vllnt.com/packages/${NAME}](${PAGE}) · [release feed](${PAGE}/rss.xml)`,
  "- All @vllnt packages: [oss.vllnt.com](https://oss.vllnt.com) · [search packages and docs on index.vllnt.com](https://index.vllnt.com)",
  `- Source and issues: [GitHub](https://github.com/vllnt/${NAME}) · [issues](https://github.com/vllnt/${NAME}/issues) · [npm](https://www.npmjs.com/package/${PACKAGE})`,
  "- Questions and updates: [Discord](https://bntvllnt.com/discord) · [X @bntvllnt](https://x.com/bntvllnt)",
  "- Company and author: [vllnt.com](https://vllnt.com) · [bntvllnt.com](https://bntvllnt.com) · [GitHub @bntvllnt](https://github.com/bntvllnt) · [LinkedIn](https://linkedin.com/in/bntvllnt)",
  "- Sponsor: [GitHub Sponsors](https://github.com/sponsors/bntvllnt)",
];

const LLMS_ECOSYSTEM = [
  "## Ecosystem",
  "",
  `- [Package page](${PAGE})`,
  `- [Release feed](${PAGE}/rss.xml)`,
  "- [All @vllnt packages](https://oss.vllnt.com/llms.txt)",
  "- [Search vllnt packages and docs](https://index.vllnt.com)",
  "- [vllnt](https://vllnt.com/llms.txt)",
  "- [Author](https://bntvllnt.com)",
];

const SHIPPED_DOCS = ["README.md", "docs/API.md", "CHANGELOG.md", "llms.txt"];

/** @type {string[]} */
const problems = [];
const fail = (message) => problems.push(message);
const read = (path) => readFileSync(path, "utf8");

/** GitHub's heading anchor: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** @returns {{ lang: string, body: string, line: number }[]} fenced code blocks */
function codeBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S*)\s*$/.exec(lines[i]);
    if (!open) continue;
    const start = i;
    const body = [];
    for (i++; i < lines.length && lines[i] !== "```"; i++) body.push(lines[i]);
    blocks.push({ lang: open[1], body: body.join("\n"), line: start + 1 });
  }
  return blocks;
}

/** Markdown text with fenced code blocks blanked out (keeps line numbers). */
function prose(text) {
  return text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
}

function headings(text) {
  return [...prose(text).matchAll(/^(#{1,6}) (.+)$/gm)].map((m) => ({
    level: m[1].length,
    text: m[2].trim(),
    index: m.index,
  }));
}

/** The body of the `## name` section of a markdown file. */
function section(text, name) {
  const all = headings(text);
  const at = all.findIndex((h) => h.level === 2 && h.text === name);
  if (at === -1) return "";
  const end = all.slice(at + 1).find((h) => h.level <= 2);
  return text.slice(all[at].index, end?.index ?? text.length);
}

const manifest = JSON.parse(read("package.json"));
const readme = read("README.md");
const api = read("docs/API.md");
const llms = read("llms.txt");

// README layout.
const readmeLines = readme.split("\n");
if (readmeLines[0] !== `# ${PACKAGE}`)
  fail(`README must start with "# ${PACKAGE}"`);
const h2 = headings(readme)
  .filter((h) => h.level === 2)
  .map((h) => h.text);
if (JSON.stringify(h2) !== JSON.stringify(SECTIONS)) {
  fail(
    `README sections must be, in order: ${SECTIONS.join(" | ")}; found: ${h2.join(" | ")}`,
  );
}
const agents = section(readme, "For coding agents")
  .split("\n")
  .slice(1)
  .filter((l) => l.trim());
if (agents.length === 0 || agents.length > 3)
  fail('"For coding agents" must hold 1 to 3 lines');
const whenToUse = section(readme, "When to use");
const [useWhen = "", avoidWhen = ""] = whenToUse.split(
  /^Do not use it when:$/m,
);
const bullets = (text) => (text.match(/^- /gm) ?? []).length;
if (bullets(useWhen) < 2 || bullets(useWhen) > 4)
  fail('"When to use" needs 2 to 4 "use it when" bullets');
if (bullets(avoidWhen) < 1 || bullets(avoidWhen) > 3)
  fail('"When to use" needs 1 to 3 "Do not use it when:" bullets');

const installLine = readmeLines.findIndex((l) =>
  l.startsWith(`pnpm add ${PACKAGE}`),
);
if (installLine === -1 || installLine >= 40)
  fail(
    `README: move "pnpm add ${PACKAGE}" into the first 40 lines (it is on line ${installLine + 1})`,
  );
const quickStart = readme.indexOf("## Quick start");
const firstExampleEnd = readmeLines.findIndex(
  (l, i) =>
    l === "```" && i > readme.slice(0, quickStart).split("\n").length + 1,
);
if (quickStart === -1 || firstExampleEnd === -1 || firstExampleEnd >= 40) {
  fail(
    "README: shorten the text above the first Quick start example so its closing ``` is within the first 40 lines",
  );
}
const quickStartBlocks = codeBlocks(readme).filter(
  (b) =>
    b.line > readme.slice(0, quickStart).split("\n").length &&
    b.line < readme.slice(0, readme.indexOf("\n## API\n")).split("\n").length,
);
const lastQuickStartLine =
  (quickStartBlocks.at(-1)?.line ?? 0) +
  (quickStartBlocks.at(-1)?.body.split("\n").length ?? 0);
const firstBadge = readmeLines.findIndex((l) => l.includes("img.shields.io"));
if (firstBadge !== -1 && firstBadge < lastQuickStartLine)
  fail("README: move the badges below the last Quick start code block");
if (readmeLines.slice(-4).join("\n") !== [...FOOTER, ""].join("\n")) {
  fail(`README must end with exactly these lines:\n${FOOTER.join("\n")}`);
}
if (section(readme, "Links").trimEnd() !== LINKS.join("\n")) {
  fail(
    `README "## Links" (right before "## License") must be exactly:\n${LINKS.join("\n")}`,
  );
}
const peer = `convex@${manifest.peerDependencies.convex}`;
if (!section(readme, "Compatibility").includes(`\`${peer}\``)) {
  fail(
    `README "## Compatibility" must name the peer range \`${peer}\` from package.json`,
  );
}

// Code blocks in shipped docs: tagged, no elided gaps; README TypeScript blocks are files.
for (const doc of SHIPPED_DOCS) {
  for (const block of codeBlocks(read(doc))) {
    if (block.lang === "")
      fail(
        `${doc}:${block.line}: code block has no language tag; open it with \`\`\`ts, \`\`\`bash or similar`,
      );
    if (
      /^\s*(\/\/\s*)?(\.\.\.|…)\s*$/m.test(block.body) ||
      block.body.includes("…")
    ) {
      fail(
        `${doc}:${block.line}: code block has a "..." gap; write the full code`,
      );
    }
  }
}
const examples = codeBlocks(readme).filter((b) => b.lang === "ts");
for (const block of examples) {
  if (!/^\/\/ convex\/[\w./-]+\.ts$/.test(block.body.split("\n")[0])) {
    fail(
      `README.md:${block.line}: a ts block must start with its file path, e.g. "// convex/orders.ts"`,
    );
  }
}

// Links and anchors in shipped docs resolve inside the package.
const packed = new Set(
  JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  )[0].files.map((f) => f.path),
);
const anchors = (path) =>
  new Set(headings(read(path)).map((h) => slug(h.text)));
for (const doc of SHIPPED_DOCS) {
  for (const [, link] of prose(read(doc)).matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
    const [path, anchor] = link.split("#");
    const target =
      path === "" ? doc : posix.normalize(posix.join(posix.dirname(doc), path));
    if (!packed.has(target)) {
      fail(
        `${doc}: link ${link} does not resolve to a packed file; fix the path or use an absolute https:// URL`,
      );
    } else if (
      anchor !== undefined &&
      target.endsWith(".md") &&
      !anchors(target).has(anchor)
    ) {
      fail(
        `${doc}: link ${link} has no matching heading in ${target}; fix the #anchor or add the heading`,
      );
    }
  }
}

// The retired vllnt ".ai" domain appears in no shipped or tracked file. It is
// built from parts so this script does not contain it either.
const retiredDomain = ["vllnt", "ai"].join(".");
const retiredPattern = new RegExp(
  `\\b${retiredDomain.replace(".", "\\.")}\\b`,
  "i",
);
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
for (const path of new Set([...packed, ...tracked])) {
  if (retiredPattern.test(read(path)))
    fail(`${path} mentions ${retiredDomain}; use vllnt.com`);
}

// llms.txt carries the same facts and ends with the ecosystem block.
if (!llms.startsWith(`# ${PACKAGE}\n\n> `))
  fail("llms.txt must start with the title and a > summary");
if (!llms.includes("\n## When to use\n"))
  fail('llms.txt lacks "## When to use"');
for (const link of ["](./docs/API.md)", "](./docs/API.md#error-codes)"]) {
  if (!llms.includes(link))
    fail(`llms.txt lacks the link ${link.slice(2, -1)}`);
}
if (!llms.trimEnd().endsWith(`\n${LLMS_ECOSYSTEM.join("\n")}`)) {
  fail(
    `llms.txt must end with exactly this block:\n${LLMS_ECOSYSTEM.join("\n")}`,
  );
}
if (llms.split("https://oss.vllnt.com/llms.txt").length !== 2) {
  fail(
    "llms.txt must link https://oss.vllnt.com/llms.txt exactly once, in the Ecosystem block; remove the other links",
  );
}

// Every public export is documented in the README API table and docs/API.md, with TSDoc.
/** @type {Map<string, string>} export name to the declaration file that holds its TSDoc */
const exported = new Map();
const declarations = (file) => {
  const text = read(file);
  for (const m of text.matchAll(
    /^export (?:declare )?(?:class|interface|function|const|type) (\w+)/gm,
  )) {
    exported.set(m[1], file);
  }
  for (const m of text.matchAll(/^export type \{([^}]+)\}/gm)) {
    for (const name of m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      exported.set(name, "dist/client/types.d.ts");
    }
  }
};
declarations("dist/client/index.d.ts");
declarations("src/test.ts");
declarations("dist/component/_generated/component.d.ts");
const apiTable = section(readme, "API");
for (const [name, file] of exported) {
  if (!new RegExp(`\`${name}\``).test(apiTable))
    fail(`README "## API" does not list \`${name}\`; add a table row for it`);
  if (!api.includes(`\`${name}\``) && !api.includes(`${name}(`))
    fail(`docs/API.md does not mention \`${name}\`; document it there`);
  const text = read(file);
  const at = text.search(
    new RegExp(
      `^export (?:declare )?(?:class|interface|function|const|type) ${name}\\b`,
      "m",
    ),
  );
  if (at !== -1 && !/\*\/\s*$/.test(text.slice(0, at)))
    fail(
      `${file}: ${name} has no TSDoc summary; add a /** ... */ comment above it in src/ and rebuild`,
    );
}
for (const method of ["begin", "complete", "get", "purge"]) {
  if (!new RegExp(`\`${method}\``).test(apiTable))
    fail(`README "## API" does not list \`${method}\`; add a table row for it`);
  const at = read("dist/client/index.d.ts").search(
    new RegExp(`^    ${method}\\(`, "m"),
  );
  if (
    at === -1 ||
    !/\*\/\s*$/.test(read("dist/client/index.d.ts").slice(0, at))
  ) {
    fail(
      `dist/client/index.d.ts: ${method} has no TSDoc summary; add one in src/client/index.ts and rebuild`,
    );
  }
}
if (!apiTable.includes("`convex.config` default"))
  fail(
    'README "## API" does not list the convex.config default export; add a "`convex.config` default" row',
  );
if (
  !/\/\*\*[^]*?\*\/\s*declare const component/.test(
    read("dist/component/convex.config.d.ts"),
  )
) {
  fail(
    "dist/component/convex.config.d.ts: the component definition has no TSDoc summary; add one in src/component/convex.config.ts and rebuild",
  );
}
const classDoc = read("dist/client/index.d.ts").match(
  /\/\*\*((?:(?!\*\/)[^])*)\*\/\s*export declare class Idempotency/,
);
if (!classDoc?.[1].includes(`@see ${PAGE}`))
  fail(
    `the Idempotency class TSDoc lacks "@see ${PAGE}"; add that line in src/client/index.ts and rebuild`,
  );

// Every error code thrown by the component is in the README and docs/API.md tables.
const codes = new Set();
for (const file of ["mutations.ts", "queries.ts"]) {
  for (const m of read(`src/component/${file}`).matchAll(/code: "([A-Z_]+)"/g))
    codes.add(m[1]);
}
const errorTable = section(readme, "Errors and fixes");
for (const code of codes) {
  if (!errorTable.includes(`\`${code}\``))
    fail(
      `README "## Errors and fixes" lacks \`${code}\`; add a row with its message, cause and fix`,
    );
  if (!section(api, "Error codes").includes(`\`${code}\``))
    fail(`docs/API.md "## Error codes" lacks \`${code}\`; add a row for it`);
}

// README TypeScript examples compile against the built package.
const work = join("node_modules", ".cache", "check-docs");
rmSync(work, { recursive: true, force: true });
const files = [];
for (const block of examples) {
  const path = block.body.split("\n")[0].slice(3);
  if (!/^convex\/[\w./-]+\.ts$/.test(path)) continue;
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), `${block.body}\n`);
  files.push(path);
}
const modules = files
  .filter(
    (p) =>
      !p.endsWith(".test.ts") &&
      !/^convex\/(schema|convex\.config)\.ts$/.test(p),
  )
  .map((p) => p.slice("convex/".length, -".ts".length));
mkdirSync(join(work, "convex", "_generated"), { recursive: true });
writeFileSync(
  join(work, "convex", "_generated", "api.ts"),
  [
    'import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";',
    'import { anyApi, componentsGeneric } from "convex/server";',
    `import type { ComponentApi } from "${PACKAGE}/_generated/component";`,
    ...modules.map((m, i) => `import type * as m${i} from "../${m}.js";`),
    `type Modules = { ${modules.map((m, i) => `"${m}": typeof m${i}`).join("; ")} };`,
    'export const api = anyApi as unknown as FilterApi<ApiFromModules<Modules>, FunctionReference<any, "public">>;',
    'export const internal = anyApi as unknown as FilterApi<ApiFromModules<Modules>, FunctionReference<any, "internal">>;',
    'export const components = componentsGeneric() as unknown as { idempotency: ComponentApi<"idempotency"> };',
    "",
  ].join("\n"),
);
writeFileSync(
  join(work, "convex", "_generated", "server.ts"),
  [
    'import type { ActionBuilder, DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from "convex/server";',
    'import { actionGeneric, internalActionGeneric, internalMutationGeneric, internalQueryGeneric, mutationGeneric, queryGeneric } from "convex/server";',
    'import type schema from "../schema.js";',
    "type DataModel = DataModelFromSchemaDefinition<typeof schema>;",
    'export const mutation = mutationGeneric as MutationBuilder<DataModel, "public">;',
    'export const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;',
    'export const query = queryGeneric as QueryBuilder<DataModel, "public">;',
    'export const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;',
    'export const action = actionGeneric as ActionBuilder<DataModel, "public">;',
    'export const internalAction = internalActionGeneric as ActionBuilder<DataModel, "internal">;',
    "",
  ].join("\n"),
);
/** @type {Record<string, string[]>} package subpaths mapped to the built files they export */
const paths = {};
for (const [key, value] of Object.entries(manifest.exports)) {
  const types =
    typeof value === "string" ? value : (value.types ?? value.default);
  if (key === "./package.json" || typeof types !== "string") continue;
  paths[posix.join(PACKAGE, key)] = [posix.join("../../..", types)];
}
writeFileSync(
  join(work, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      target: "ES2022",
      lib: ["ES2022", "DOM"],
      module: "ESNext",
      moduleResolution: "Bundler",
      types: ["vite/client"],
      skipLibCheck: true,
      paths,
    },
    include: ["convex/**/*.ts"],
  }),
);
try {
  execFileSync(
    join("node_modules", ".bin", "tsc"),
    ["--project", join(work, "tsconfig.json")],
    { encoding: "utf8", stdio: "pipe" },
  );
} catch (error) {
  fail(
    `README TypeScript examples do not type-check against the built package (dist/); fix the example or the export name, then rerun pnpm build && pnpm test:package:\n${error.stdout}`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
console.log(
  `OK    docs: ${SECTIONS.length} sections, ${exported.size} exports, ${codes.size} error codes, ${files.length} examples compile`,
);
