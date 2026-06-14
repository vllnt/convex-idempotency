<!-- Badges -->
[![convex-component](https://img.shields.io/badge/convex-component-EE342F.svg)](https://www.convex.dev/components)
[![npm](https://img.shields.io/npm/v/@vllnt/convex-idempotency.svg)](https://www.npmjs.com/package/@vllnt/convex-idempotency)
[![CI](https://github.com/vllnt/convex-idempotency/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-idempotency/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@vllnt/convex-idempotency.svg)](./LICENSE)

# @vllnt/convex-idempotency

Exactly-once idempotency key ledger for retried operations, as a Convex component.

```ts
const idem = new Idempotency(components.idempotency);
const claim = await idem.begin(ctx, requestId);   // mints a claim, or short-circuits a replay
if (claim.state === "done") return claim.result;  // replayed — skip the work
// ... run the work ...
await idem.complete(ctx, requestId, result);      // record the outcome for next time
```

Record an idempotency `key` with a grace TTL; on a replay short-circuit and return the prior outcome
instead of re-running the work. Domain-neutral: payment intents, webhook deliveries, queue consumers,
double-submit guards — any operation that must run **at most once** per key.

## Features

- **Exactly-once** per `(scope, key)` — `begin` mints an inflight claim that rides the mutation transaction; a concurrent retry sees `inflight` with a `retryAfterMs` backoff hint.
- **Replay** — once `complete` records an outcome, a later `begin` returns `{ state: "done", result }` for a short-circuit.
- **Split TTLs** — a short **inflight lease** (default 60s) so a crashed worker's claim self-heals, and a longer **done grace** (default 24h) after which a key may be re-minted.
- **Lost-claim detection** — `complete` returns `{ recorded: true } | { recorded: false, reason }` so a host knows when its work finished but the row was gone. Opt into `upsertOnMissing`.
- **Server-sourced time** — expiry is read from the server clock; a caller can't supply `now`, so an adversarial clock can't force a key to look live or expired.
- **TTL validation** — non-positive or infinite TTLs throw `INVALID_TTL` before any write.
- **Typed result** — `Idempotency<TResult>` types the stored outcome; a `resultValidator` narrows it at the boundary.
- **Scopes** — global by default, or namespace per tenant / operation type.
- **Bounded purge + cron** — a daily cron sweeps expired keys in batches and self-reschedules until clean.

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

| Method | Kind | Result |
|--------|------|--------|
| `begin(ctx, key, opts?)` | mutation | `{ state: "fresh" } \| { state: "inflight"; expiresAt; retryAfterMs } \| { state: "done"; result? }` |
| `complete(ctx, key, result?, opts?)` | mutation | `{ recorded: true } \| { recorded: false; reason: "missing" \| "expired" \| "already_done" }` |
| `get(ctx, key, scope?)` | query | `{ status, result?, expiresAt } \| null` |
| `purge(ctx, opts?)` | mutation | `number` (keys removed in the first bounded pass) |

Full reference: [docs/API.md](docs/API.md).

## React

Backend-only — no `./react` entry. Pure infra dedup with no user-facing reactive surface.

## Security

- Auth-agnostic — the host resolves identity and decides who may run an operation.
- Tables sandboxed — reached only through the exported functions.
- Server-sourced expiry — a skewed client clock can't hijack a replay or bypass dedup; `key` / `scope` / `result` stay opaque.

See [docs/API.md](docs/API.md).

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
