<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `example/convex/_generated/ai/guidelines.md` first** for
important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

# @vllnt/convex-idempotency

Exactly-once idempotency key ledger for retried operations, as a Convex component. It follows the
vllnt Component Standard (see the `convex-components` hub `.claude/rules/component-standard.md`).

## Architecture

```
src/
├── shared.ts              # constants: component name, default scope, TTLs, batch size
├── test.ts                # convex-test register() helper
├── client/
│   ├── index.ts           # Idempotency<TResult> class (consumer-facing API)
│   └── types.ts           # public TypeScript interfaces
└── component/
    ├── schema.ts           # sandboxed table: keys {key, scope, status, result?, expiresAt}
    ├── convex.config.ts    # defineComponent("idempotency")
    ├── mutations.ts        # begin, complete, purge
    ├── queries.ts          # get
    ├── validators.ts       # shared validators (beginResult, completeResult, jsonValue)
    └── crons.ts            # daily purge cron (self-rescheduling)
```

Sandboxed table: `keys` — unique per `(scope, key)`, indexed `by_scope_key` (lookup) and
`by_expires` (sweep). No host tables are touched. The stored `result` is opaque to the component;
the host narrows it via a `resultValidator` at the client boundary.

## Ownership boundary

**Component owns:**

- The dedup ledger (`keys` table) — mint, expire, purge
- Server-sourced time — `Date.now()` inside every handler; no caller-supplied `now`
- TTL validation — `inflightTtlMs` / `doneTtlMs` must be positive finite numbers
- Lifecycle: `absent → inflight → done → expired → re-minted`
- The discriminated return shapes (`BeginResult`, `CompleteResult`)
- The daily purge cron and `purge` mutation

**Host owns:**

- The operation being deduped and its domain meaning
- Auth and authorization — whether a caller may use a given key/scope
- The stored `result` type (`TResult`) — opaque to the component, narrowed by `resultValidator`
- Interpreting `{ state: "inflight" }` (backoff) and `{ recorded: false }` (lost claim)

**Auth:** the component is completely auth-agnostic. The host resolves identity, decides access, and
passes an opaque `key`. `scope` provides namespacing per tenant/operation-type; both are opaque strings.

## Key design decisions

- **Expiry-before-done in `begin` (intentional asymmetry):** `begin` checks expiry **before**
  done-state. An expired done key is therefore re-minted `fresh` — the grace window has elapsed and
  the operation may safely re-run. This is the correct recovery path: the done grace exists precisely
  to replay within the window; outside it the key behaves as never-seen.

- **Done-before-expiry in `complete` (intentional asymmetry):** `complete` checks done-state
  **before** expiry. An expired done key returns `already_done`, not `expired`. A late attempt must
  never overwrite a prior winner's recorded outcome — the `expired` reason is reserved for inflight
  keys whose lease lapsed before completion.

- **Server-sourced time:** every handler calls `Date.now()` internally; no API surface accepts a
  caller-supplied `now`. A hostile or skewed client clock cannot force a key to look live (hijack a
  replay) or expired (bypass dedup).

- **INVALID_TTL guard:** `inflightTtlMs` and `doneTtlMs` must be positive finite numbers. Passing
  `0`, a negative, or `Infinity` throws `ConvexError({ code: "INVALID_TTL" })` before any write.
  A zero/negative TTL would produce `expiresAt ≤ now`, immediately expiring the claim.

- **Row re-mint in place:** an expired key is patched (status reset, result cleared, new
  `expiresAt`) rather than deleted and re-inserted, preserving the row `_id` across the re-mint.

- **Replay without re-execution:** `begin` returning `{ state: "done", result }` short-circuits the
  caller; the result is the stored validated value — the work is never re-executed.

- **Bounded purge + self-reschedule:** `purge` removes up to `batch` expired keys (default 200) per
  pass and self-reschedules via `ctx.scheduler` when a full batch was removed, running until the
  tail is clean. Idempotent and safe to call anytime. The built-in daily cron drives it
  automatically.

- **Backend-only (no `./react` entry):** pure infra dedup — no user-facing reactive surface. No
  hooks or client components shipped. This was an explicit analysis decision (see README).

## Conventions

- Mutations in `mutations.ts`, queries in `queries.ts` (enforced by `@vllnt/eslint-config/convex`).
- Explicit `args` + `returns` on every Convex function.
- Host data via typed generics / `resultValidator` — never `v.any()` dumps; `jsonValue` is the
  documented last resort for the stored opaque result.
- 100% test coverage is BLOCKING (`vitest.config.mts` thresholds: statements, branches, functions, lines).
- Runtime deps: only official `@convex-dev/*` + `@vllnt/*`.

## Docs sync

| Changed | Update in the same commit |
|---------|--------------------------|
| Public API (begin/complete/get/purge signatures) | README API Reference table, `docs/API.md`, `llms.txt` context, regenerate `llms-full.txt` |
| Config options / defaults | README API Reference, `docs/API.md` constructor section |
| Schema / table / indexes | README Architecture, `docs/API.md` |
| Error codes | `docs/API.md` → `## Error codes` table |
| `peerDependencies.convex` version | `llms.txt` context line (`convex@^X.Y.Z`), `docs/API.md` Compatibility line, README Installation peer note |
| Lifecycle / expiry asymmetry | `docs/API.md` begin/complete sections, Key design decisions above |
| Any change | `pnpm generate:llms` to keep `llms-full.txt` current |

Grep old values before committing (e.g. `git grep "1.36.1"` → must be empty).
