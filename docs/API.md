# API Reference — @vllnt/convex-idempotency

Construct the client with the mounted component and optional config:

```ts
import { Idempotency } from "@vllnt/convex-idempotency";
import { v } from "convex/values";

const idem = new Idempotency<MyResult>(components.idempotency, {
  defaultScope: "global",        // namespace applied when a call omits `scope`
  defaultInflightTtlMs: 60_000,  // inflight lease (ms) when `begin` omits `inflightTtlMs` (60s)
  defaultDoneTtlMs: 86_400_000,  // done grace (ms) when `complete` omits `doneTtlMs` (24h)
  upsertOnMissing: false,        // record finished work even if the claim row vanished
  resultValidator: v.object({ id: v.string() }).parse, // narrow the opaque result at the boundary
});
```

`Idempotency<TResult = unknown>` is generic over the host's stored outcome type.
All methods take the host `ctx` (a query or mutation context) as the first
argument.

**Time is server-sourced.** Every handler reads `Date.now()` itself; no method
accepts a caller-supplied `now`, so a skewed or hostile client clock cannot make
a key look live or expired.

**Result validation.** When `resultValidator` is set it runs at the client
boundary: over the value written by `complete` (before storage) and over the
value returned by `begin` (`done` replay) and `get`. It must return a typed
`TResult` or throw. Omit it to leave results unvalidated.

## Mutations

### `begin(ctx, key, opts?) → BeginResult`

`opts`: `{ scope?: string; inflightTtlMs?: number }`.

Claim `key` for an operation. The discriminated result is:

- `{ state: "fresh" }` — the key was just minted (or a prior claim had expired and
  was re-minted in place); the caller should perform the work and then call
  `complete`.
- `{ state: "inflight"; expiresAt; retryAfterMs }` — another attempt holds an
  unexpired claim; do not re-run. `expiresAt` is when the lease frees and
  `retryAfterMs` is the backoff before retrying.
- `{ state: "done"; result? }` — a prior attempt already completed; `result`
  carries the recorded outcome (validated) for a short-circuit replay.

Mints an inflight key with `expiresAt = now + inflightTtlMs`. An expired key (any
status) is re-minted `fresh` by patching the existing row in place (the id is
reused, the stale result cleared).

### `complete(ctx, key, result?, opts?) → CompleteResult`

`opts`: `{ scope?: string; doneTtlMs?: number; upsertOnMissing?: boolean }`.

Mark `key` `done`, recording `result` and extending the grace window
(`expiresAt = now + doneTtlMs`). The discriminated result lets a host detect a
lost claim:

- `{ recorded: true }` — the outcome was written.
- `{ recorded: false; reason }` — the claim was lost; `reason` is `missing` (no
  key), `expired` (the inflight lease lapsed before completion), or `already_done`
  (a prior attempt won).

When `upsertOnMissing` is set, a `missing`/`expired` key is written as `done`
anyway — recording finished work rather than dropping it (returns
`{ recorded: true }`).

### `purge(ctx, opts?) → number`

`opts`: `{ before?: number; batch?: number }` (defaults: `before = Date.now()`,
`batch = 200`).

Delete up to `batch` keys whose `expiresAt < before`, oldest first via the
`by_expires` index, and return the count removed in the first pass. If a full
batch was removed the sweep self-reschedules through the component scheduler until
the expired tail is clean. Idempotent — safe to run anytime. A built-in daily cron
(`crons.ts`) drives this automatically; call `purge` directly only for an extra or
custom-cadence sweep.

## Queries

### `get(ctx, key, scope?) → { status, result?, expiresAt } | null`

The stored state for `key` in `scope`, or `null` if no key is held. `status` is
`inflight` or `done`; `result` is present only when `done` (validated); `expiresAt`
is the absolute ms timestamp after which the key may be re-minted.
