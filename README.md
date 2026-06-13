<!-- Badges -->
[![convex-component](https://img.shields.io/badge/convex-component-EE342F.svg)](https://www.convex.dev/components)
[![npm](https://img.shields.io/npm/v/@vllnt/convex-idempotency.svg)](https://www.npmjs.com/package/@vllnt/convex-idempotency)
[![CI](https://github.com/vllnt/convex-idempotency/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-idempotency/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@vllnt/convex-idempotency.svg)](./LICENSE)

# @vllnt/convex-idempotency

Exactly-once idempotency key ledger for retried operations, as a Convex component.

Record an idempotency `key` with a grace TTL; on a replay short-circuit and
return the prior outcome instead of re-running the work. Domain-neutral: payment
intents, webhook deliveries, queue consumers, double-submit guards — any
operation that must run **at most once** per key. The host owns the operation,
its meaning, and auth; this component owns only the dedup ledger.

## Features

- **Exactly-once** per `(scope, key)` — `begin` mints an inflight claim that rides the Convex mutation transaction; a concurrent retry sees `inflight` with a `retryAfterMs` backoff hint.
- **Replay** — once `complete` records an outcome, a later `begin` returns `{ state: "done", result }` for a short-circuit.
- **Split TTLs** — a short **inflight lease** (`inflightTtlMs`, default 60s) so a crashed worker's claim self-heals fast, and a longer **done grace** (`doneTtlMs`, default 24h) after which a key may be re-minted in place.
- **Lost-claim detection** — `complete` returns a discriminated `{ recorded: true } | { recorded: false, reason }` so a host knows when its work finished but the ledger row was gone (`missing` / `expired` / `already_done`). Opt into `upsertOnMissing` to record it anyway.
- **Server-sourced time** — expiry is read from the server clock inside every handler; a caller can never supply `now`, so an adversarial clock cannot force a key to look live or expired.
- **TTL validation** — `inflightTtlMs` and `doneTtlMs` must be positive finite numbers. Passing `0`, a negative value, or `Infinity` throws `ConvexError({ code: "INVALID_TTL" })` before any write, preventing a key from expiring immediately on creation.
- **Typed result** — `Idempotency<TResult>` types the stored outcome end to end; pass a `resultValidator` to narrow the opaque stored value at the boundary (no unchecked cast). The component stores it opaquely.
- **Scopes** — global by default, or namespace per tenant / operation type.
- **Bounded purge + cron** — a built-in daily prune cron sweeps expired keys in bounded batches and self-reschedules until the tail is clean; idempotent, safe to run anytime.

## Architecture

```
src/
├── shared.ts              # constants (component name, default scope, TTLs, batch)
├── test.ts                # convex-test register() helper
├── client/                # Idempotency class (the public API)
└── component/             # schema (keys) + mutations + queries + prune cron
```

Sandboxed table: `keys {key, scope, status, result?, expiresAt}` — unique per
`(scope, key)`, indexed for lookup (`by_scope_key`) and sweep (`by_expires`). A
built-in cron (`crons.ts`) prunes expired keys daily.

## Installation

```bash
pnpm add @vllnt/convex-idempotency
```

Peer dependency: `convex@^1.41.0`.

## Usage

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import idempotency from "@vllnt/convex-idempotency/convex.config";

const app = defineApp();
app.use(idempotency);
export default app;
```

```ts
// convex/charge.ts — host owns auth; pass an opaque idempotency key in.
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { Idempotency } from "@vllnt/convex-idempotency";

const idem = new Idempotency<{ chargeId: string }>(components.idempotency, {
  resultValidator: v.object({ chargeId: v.string() }).parse, // narrow at the boundary
});

export const charge = mutation({
  args: { requestId: v.string(), amount: v.number() },
  handler: async (ctx, { requestId, amount }) => {
    const claim = await idem.begin(ctx, requestId);
    if (claim.state === "done") return claim.result;          // typed replay
    if (claim.state === "inflight")
      throw new Error(`retry in ${claim.retryAfterMs}ms`);    // backoff hint
    const result = { chargeId: await doCharge(amount) };      // state === "fresh"
    const done = await idem.complete(ctx, requestId, result);
    if (!done.recorded) console.warn("claim lost:", done.reason); // work ran, row gone
    return result;
  },
});
```

## API Reference

See [docs/API.md](docs/API.md). Summary:

| Method | Kind | Result |
|--------|------|--------|
| `begin(ctx, key, opts?)` | mutation | `{ state: "fresh" } \| { state: "inflight"; expiresAt; retryAfterMs } \| { state: "done"; result? }` |
| `complete(ctx, key, result?, opts?)` | mutation | `{ recorded: true } \| { recorded: false; reason: "missing" \| "expired" \| "already_done" }` |
| `get(ctx, key, scope?)` | query | `{ status, result?, expiresAt } \| null` |
| `purge(ctx, opts?)` | mutation | `number` (keys removed in the first bounded pass) |

`begin` opts: `{ scope?; inflightTtlMs? }`. `complete` opts:
`{ scope?; doneTtlMs?; upsertOnMissing? }`. `purge` opts: `{ before?; batch? }`.
Client options: `new Idempotency(component, { defaultScope = "global",
defaultInflightTtlMs = 60_000, defaultDoneTtlMs = 86_400_000, upsertOnMissing =
false, resultValidator? })`.

## Security Model

The component is **auth-agnostic**: it never authenticates or authorizes. The
host resolves identity, decides whether a caller may run an operation, and passes
an opaque `key`. Component tables are sandboxed — the host reaches them only
through the exported functions. `key`, `scope`, and the stored `result` are
opaque to the component; it never inspects or de-references them.

**Time is server-sourced.** Expiry is read from `Date.now()` inside every handler
— the API takes no caller-supplied `now`, so a hostile or skewed client clock
cannot make a key appear live (to hijack a replay) or expired (to bypass the
dedup). The host may narrow the opaque stored `result` with a `resultValidator`,
applied at the client boundary on both write (`complete`) and read
(`begin`/`get`).

## Testing

```bash
pnpm test           # single run
pnpm test:coverage  # enforced 100% on covered files
```

Tests run against the real component runtime via `convex-test` (`@edge-runtime/vm`), not mocks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Author

Built by [bntvllnt](https://github.com/bntvllnt) · [bntvllnt.com](https://bntvllnt.com) · [X @bntvllnt](https://x.com/bntvllnt)

Part of the [@vllnt](https://github.com/vllnt) Convex component fleet — [vllnt.com](https://vllnt.com)

If this is useful, [sponsor the work](https://github.com/sponsors/bntvllnt).

## License

MIT — see [LICENSE](LICENSE).
