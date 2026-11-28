import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * Installs the real npm tarball in a clean consumer project and uses it the way
 * a host app does. Run after `pnpm build`.
 *
 * 1. `npm pack` the package, then `pnpm install` the tarball with the `convex`,
 *    `convex-test` and `vite` versions locked in pnpm-lock.yaml.
 * 2. Node imports every runtime entry point in package.json "exports".
 * 3. This repo's vitest runs `register` from `/test` (it needs Vite's
 *    `import.meta.glob`) and calls the mounted component.
 * 4. This repo's tsc type-checks a strict consumer that uses every public export
 *    under `moduleResolution` `bundler` and `nodenext`, with `skipLibCheck: false`.
 *
 * The temp directory is removed on success and on failure.
 */

const ROOT = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PACKAGE = manifest.name;
/** Runs under vitest, not plain Node: it uses `import.meta.glob`. */
const TEST_ENTRY = "./test";
const PEERS = ["convex", "convex-test", "vite"];

/** @param {string} name @returns {string} the version this repo's lockfile pins */
function lockedVersion(name) {
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  const importer = lock.split("\nimporters:\n")[1]?.split("\npackages:\n")[0];
  const match = new RegExp(
    `\\n {6}'?${name}'?:\\n {8}specifier: [^\\n]+\\n {8}version: ([^\\s(]+)`,
  ).exec(importer ?? "");
  if (match === null) throw new Error(`pnpm-lock.yaml does not lock ${name}`);
  return match[1];
}

/** @param {unknown} target @returns {boolean} whether Node can load this export */
function hasRuntimeTarget(target) {
  return (
    typeof target === "string" ||
    (typeof target === "object" && target !== null && "default" in target)
  );
}

/**
 * @param {string} step
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} stdout
 */
function run(step, command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(`${step}:\n${output.trim() || error.message}`);
  }
}

/** @param {string} path @param {string | object} content */
function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
}

const entries = Object.entries(manifest.exports);
const runtimeEntries = entries
  .filter(([key, target]) => key !== TEST_ENTRY && hasRuntimeTarget(target))
  .map(([key]) => key);
const typedEntries = entries
  .map(([key]) => key)
  .filter((key) => key !== "./package.json");
const spec = (key) => (key === "." ? PACKAGE : `${PACKAGE}${key.slice(1)}`);

const RUNTIME_CHECK = `
const name = ${JSON.stringify(PACKAGE)};
const keys = ${JSON.stringify(runtimeEntries)};
const failures = [];
const loaded = {};
for (const key of keys) {
  const id = key === "." ? name : name + key.slice(1);
  try {
    loaded[key] = key.endsWith(".json")
      ? await import(id, { with: { type: "json" } })
      : await import(id);
  } catch (error) {
    failures.push(\`cannot import \${id}: \${error.message}\`);
  }
}
const expect = (ok, message) => { if (!ok) failures.push(message); };
const root = loaded["."];
if (root) {
  expect(typeof root.Idempotency === "function", "Idempotency is not exported as a class");
  try {
    new root.Idempotency({ mutations: {}, queries: {} });
  } catch (error) {
    failures.push(\`new Idempotency(...) throws: \${error.message}\`);
  }
}
for (const key of ["./convex.config", "./convex.config.js"]) {
  if (loaded[key]) {
    const value = loaded[key].default;
    expect(typeof value === "object" && value !== null, \`\${name}\${key.slice(1)} has no default component definition\`);
  }
}
const pkg = loaded["./package.json"];
if (pkg) {
  expect(pkg.default.name === name && pkg.default.version === ${JSON.stringify(manifest.version)}, "package.json name or version does not match");
}
if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(keys.length);
`;

// Runs under this repo's vitest with --globals, so it imports nothing from vitest.
const REGISTER_TEST = `
import { convexTest } from "convex-test";
import { componentsGeneric, defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { register } from "${PACKAGE}/test";

test("register mounts the installed component", async () => {
  const schema = defineSchema({ notes: defineTable({ text: v.string() }) });
  // convex-test locates the host's modules by their _generated directory.
  const t = convexTest(schema, { "./convex/_generated/api.ts": async () => ({}) });
  register(t);
  const { begin } = componentsGeneric().idempotency.mutations;
  const args = { key: "order-1", scope: "orders", inflightTtlMs: 60_000 };
  expect((await t.mutation(begin, args)).state).toBe("fresh");
  expect((await t.mutation(begin, args)).state).toBe("inflight");
});
`;

const CONSUMER = `
import { Idempotency } from "${PACKAGE}";
import type {
  BeginResult,
  CompleteResult,
  IdempotencyComponent,
  IdempotencyOptions,
  KeyState,
  ResultParser,
} from "${PACKAGE}";
import idempotency from "${PACKAGE}/convex.config";
import type { ComponentApi } from "${PACKAGE}/_generated/component";
import { register } from "${PACKAGE}/test";
import { convexTest } from "convex-test";
import {
  componentsGeneric,
  defineApp,
  defineSchema,
  defineTable,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
${typedEntries
  .map((key, i) => `import type * as entry${i} from "${spec(key)}";`)
  .join("\n")}

export type Entries = [${typedEntries.map((_, i) => `typeof entry${i}`).join(", ")}];

const app = defineApp();
app.use(idempotency);
export default app;

const components = componentsGeneric() as unknown as {
  idempotency: ComponentApi<"idempotency">;
};
const component: IdempotencyComponent = components.idempotency;

interface Charge {
  chargeId: string;
}
const parseCharge: ResultParser<Charge> = (value) => {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { chargeId?: unknown }).chargeId === "string"
  ) {
    return value as Charge;
  }
  throw new Error("invalid charge");
};
const options: IdempotencyOptions<Charge> = {
  defaultScope: "payments",
  defaultInflightTtlMs: undefined,
  resultValidator: parseCharge,
};
const idem = new Idempotency<Charge>(component, options);

export const charge = mutationGeneric({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<string> => {
    const started: BeginResult<Charge> = await idem.begin(ctx, key);
    if (started.state === "done") return started.result?.chargeId ?? "none";
    if (started.state === "inflight") return \`retry in \${started.retryAfterMs}\`;
    const recorded: CompleteResult = await idem.complete(
      ctx,
      key,
      { chargeId: "ch_1" },
      { claimId: started.claimId, scope: undefined },
    );
    return recorded.recorded ? "recorded" : recorded.reason;
  },
});

export const status = queryGeneric({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<KeyState<Charge> | null> =>
    idem.get(ctx, key),
});

export const sweep = mutationGeneric({
  args: {},
  handler: async (ctx): Promise<number> => idem.purge(ctx, { batch: 10 }),
});

const hostSchema = defineSchema({ notes: defineTable({ text: v.string() }) });
export function mountForTests(): void {
  const t = convexTest(hostSchema, {});
  register(t);
  register(t, "second");
}
`;

/** @param {string} resolution */
function tsconfig(resolution) {
  return {
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: false,
      noEmit: true,
      target: "ES2022",
      lib: ["ES2022", "DOM"],
      module: resolution === "nodenext" ? "NodeNext" : "ESNext",
      moduleResolution: resolution,
      types: [],
    },
    files: ["src/consumer.ts"],
  };
}

const work = mkdtempSync(join(tmpdir(), "convex-idempotency-consumer-"));
let failure;
try {
  const packDir = join(work, "pack");
  mkdirSync(packDir);
  const packed = run(
    "npm pack failed",
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    ROOT,
  );
  const tarball = join(packDir, JSON.parse(packed)[0].filename);

  const app = join(work, "consumer");
  write(join(app, "package.json"), {
    name: "consumer",
    private: true,
    type: "module",
    dependencies: {
      [PACKAGE]: `file:${tarball}`,
      ...Object.fromEntries(PEERS.map((name) => [name, lockedVersion(name)])),
    },
    // Same release-age gate and overrides as this repo.
    pnpm: manifest.pnpm,
  });
  run(
    "pnpm install of the packed tarball failed",
    "pnpm",
    [
      "install",
      "--prefer-offline",
      "--no-frozen-lockfile",
      "--reporter=silent",
    ],
    app,
  );

  write(join(app, "runtime-check.mjs"), RUNTIME_CHECK);
  const imported = run(
    "a runtime entry point does not load in Node",
    process.execPath,
    ["runtime-check.mjs"],
    app,
  ).trim();

  write(join(app, "test", "register.test.ts"), REGISTER_TEST);
  run(
    `${PACKAGE}/test failed under vitest`,
    join(ROOT, "node_modules", ".bin", "vitest"),
    ["run", "--root", app, "--globals"],
    app,
  );

  write(join(app, "src", "consumer.ts"), CONSUMER);
  const resolutions = ["bundler", "nodenext"];
  for (const resolution of resolutions) {
    const config = join(app, `tsconfig.${resolution}.json`);
    write(config, tsconfig(resolution));
    run(
      `the consumer does not type-check against the installed package (moduleResolution ${resolution})`,
      join(ROOT, "node_modules", ".bin", "tsc"),
      ["--project", config],
      app,
    );
  }
  console.log(
    `OK    consumer: installed ${PACKAGE}, ${imported} runtime entry points load, /test runs under vitest, strict consumer type-checks (${resolutions.join(", ")})`,
  );
} catch (error) {
  failure = error;
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failure !== undefined) {
  console.error(`FAIL ${failure.message}`);
  process.exit(1);
}
