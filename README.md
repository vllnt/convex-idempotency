<!-- Badges -->

[![convex-component](https://img.shields.io/badge/convex-component-EE342F.svg)](https://www.convex.dev/components)
[![npm](https://img.shields.io/npm/v/@vllnt/convex-idempotency.svg)](https://www.npmjs.com/package/@vllnt/convex-idempotency)
[![CI](https://github.com/vllnt/convex-idempotency/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-idempotency/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@vllnt/convex-idempotency.svg)](./LICENSE)

# @vllnt/convex-idempotency

Lease-based idempotency key ledger for retried operations, as a Convex
component.

```ts
const idem = new Idempotency(components.idempotency);
const claim = await idem.begin(ctx, requestId); // mints a claim, or short-circuits a replay
if (claim.state === "done") return claim.result; // replayed — skip the work
if (claim.state === "inflight") throw new Error("Retry later");
// ... run the work only for a fresh claim ...
const completion = await idem.complete(ctx, requestId, result, {
  claimId: claim.claimId,
});
if (!completion.recorded) throw new Error(`Claim lost: ${completion.reason}`);
```

Record an idempotency `key` with a grace TTL; on a replay short-circuit and
return the prior outcome instead of re-running the work. Domain-neutral: payment
intents, webhook deliveries, queue consumers, double-submit guards. The ledger
fences completion of replaced leases; it does not guarantee exactly-once
external side effects. A worker can finish an external operation and crash
before recording it. Use the provider's idempotency key too.

## Features

- **Exclusive live claim** per `(scope, key)` — `begin` mints an inflight claim
  that rides the mutation transaction; a concurrent retry sees `inflight` with a
  `retryAfterMs` backoff hint.
- **Replay** — once `complete` records an outcome, a later `begin` returns
  `{ state: "done", result }` for a short-circuit.
- **Split TTLs** — a short **inflight lease** (default 60s) so a crashed
  worker's claim self-heals, and a longer **done grace** (default 24h) after
  which a key may be re-minted.
- **Lost-claim detection** — `complete` returns
  `{ recorded: true } | { recorded: false, reason }` so a host knows when its
  work finished but the row was gone. Opt into `upsertOnMissing`.
- **Server-sourced time** — expiry is read from the server clock; a caller can't
  supply `now`, so an adversarial clock can't force a key to look live or
  expired.
- **TTL validation** — non-positive or infinite TTLs throw `INVALID_TTL` before
  any write.
- **Typed result** — `Idempotency<TResult>` types the stored outcome; a
  `resultValidator` narrows it at the boundary.
- **Scopes** — global by default, or namespace per tenant / operation type.
- **Bounded purge + cron** — a daily cron sweeps expired keys in batches and
  self-reschedules until clean.

## Installation

```bash
pnpm add @vllnt/convex-idempotency
```

Requires `convex@^1.45.0`. The command installs `latest` (`0.1.0`). This README
describes current `main` / `canary`, including `claimId` fencing; install
`@vllnt/convex-idempotency@canary` for that API and pin the resolved prerelease
version for reproducible installs.

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
// convex/requests.ts — record a result in one authenticated mutation.
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { Idempotency } from "@vllnt/convex-idempotency";

const idem = new Idempotency<{ accepted: boolean }>(components.idempotency, {
  resultValidator: (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("accepted" in value) ||
      typeof value.accepted !== "boolean"
    ) {
      throw new Error("Invalid stored result");
    }
    return { accepted: value.accepted };
  },
});

export const accept = mutation({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const scope = identity.tokenIdentifier;
    const claim = await idem.begin(ctx, requestId, { scope });
    if (claim.state === "done") return claim.result;
    if (claim.state === "inflight")
      throw new Error(`Retry in ${claim.retryAfterMs}ms`);
    // Put transactional host database writes here, not external network calls.
    const result = { accepted: true };
    const done = await idem.complete(ctx, requestId, result, {
      scope,
      claimId: claim.claimId,
    });
    if (!done.recorded) throw new Error(`Claim lost: ${done.reason}`);
    return result;
  },
});
```

For external work, use a host action with separate claim/completion mutations;
carry the same `scope` and `claimId` through both. Do not execute work for an
`inflight` response, and handle a failed completion without blindly repeating
the side effect. After either TTL expires, the key can be claimed again.

## API Reference

| Method                               | Kind     | Result                                                                                                        |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| `begin(ctx, key, opts?)`             | mutation | `{ state: "fresh"; claimId } \| { state: "inflight"; expiresAt; retryAfterMs } \| { state: "done"; result? }` |
| `complete(ctx, key, result?, opts?)` | mutation | `{ recorded: true } \| { recorded: false; reason: "missing" \| "expired" \| "superseded" \| "already_done" }` |
| `get(ctx, key, scope?)`              | query    | `{ status, result?, expiresAt } \| null`                                                                      |
| `purge(ctx, opts?)`                  | mutation | `number` (keys removed in the first bounded pass)                                                             |

Full reference: [docs/API.md](docs/API.md).

## React

Backend-only — no `./react` entry. Pure infra dedup with no user-facing reactive
surface.

## Security

- Auth-agnostic — the host resolves identity and decides who may run an
  operation.
- Tables sandboxed — reached only through the exported functions.
- Server-sourced expiry — a skewed client clock can't hijack a replay or bypass
  dedup; `key` / `scope` / `result` stay opaque.

See [docs/API.md](docs/API.md).

## Testing

```bash
pnpm test           # single run
pnpm test:coverage  # enforced 100% on covered files
```

Tests run against the real component runtime via `convex-test`
(`@edge-runtime/vm`), not mocks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Author

Built by [bntvllnt](https://github.com/bntvllnt) ·
[bntvllnt.com](https://bntvllnt.com) · [X @bntvllnt](https://x.com/bntvllnt)

Part of the [@vllnt](https://github.com/vllnt) Convex component fleet —
[vllnt.com](https://vllnt.com)

If this is useful, [sponsor the work](https://github.com/sponsors/bntvllnt).

## License

MIT — see [LICENSE](LICENSE).
