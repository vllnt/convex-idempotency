# @vllnt/convex-idempotency

Convex component that records idempotency keys so a retried mutation, webhook or job replays its stored result instead of running twice.

## For coding agents

Docs for the installed version ship in the package: `docs/API.md`, `README.md`, `CHANGELOG.md`, `llms.txt` and typed `src/` under `node_modules/@vllnt/convex-idempotency/`. Read them before writing code.

## When to use

Use it when:

- A Convex mutation can be retried and must not apply its writes twice.
- A webhook, queue consumer or form submit arrives more than once with the same ID, and the repeat should return the first result.
- You need one live claim per key, with a lease that frees itself if the worker crashes.

Do not use it when:

- You need exactly-once external side effects (a charge, an email): use the provider's own idempotency key; this ledger only dedups Convex work.
- You send email, meter usage or move balances: `@vllnt/convex-email`, `@vllnt/convex-metering` and `@vllnt/convex-wallet` dedup those themselves.

## Install

```bash
pnpm add @vllnt/convex-idempotency
```

## Quick start

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import idempotency from "@vllnt/convex-idempotency/convex.config";

const app = defineApp();
app.use(idempotency);
export default app;
```

```ts
// convex/orders.ts
import { v } from "convex/values";
import { Idempotency } from "@vllnt/convex-idempotency";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

const idem = new Idempotency<{ orderId: string }>(components.idempotency);

export const placeOrder = mutation({
  args: { requestId: v.string(), item: v.string() },
  handler: async (ctx, { requestId, item }) => {
    const claim = await idem.begin(ctx, requestId);
    if (claim.state === "done") return claim.result ?? null;
    if (claim.state === "inflight") throw new Error("Retry later");
    const result = { orderId: await ctx.db.insert("orders", { item }) };
    await idem.complete(ctx, requestId, result, { claimId: claim.claimId });
    return result;
  },
});
```

A retry with the same `requestId` returns the first `orderId` and inserts nothing within the 24 h done grace. Claim, insert and record run in one mutation transaction: if the handler throws, all three roll back. For work split across functions, see [Common tasks](#common-tasks).

The host schema needs the `orders` table used above:

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  orders: defineTable({ item: v.string() }),
});
```

[![npm](https://img.shields.io/npm/v/@vllnt/convex-idempotency.svg)](https://www.npmjs.com/package/@vllnt/convex-idempotency)
[![CI](https://github.com/vllnt/convex-idempotency/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-idempotency/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@vllnt/convex-idempotency.svg)](./LICENSE)

## API

Full reference: [docs/API.md](./docs/API.md).

| Export                                                                        | Kind                                               | What it does                                                                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`Idempotency`](./docs/API.md#client)                                         | class (`@vllnt/convex-idempotency`)                | Client: `new Idempotency<TResult>(components.idempotency, options?)`                                                  |
| [`begin`](./docs/API.md#beginctx-key-opts--beginresult)                       | method, `runMutation` ctx (mutation or action)     | Claim a key: `fresh` with a `claimId`, `inflight` with `retryAfterMs`, or `done` with the stored `result`             |
| [`complete`](./docs/API.md#completectx-key-result-opts--completeresult)       | method, `runMutation` ctx (mutation or action)     | Record the result: `{ recorded: true }` or `{ recorded: false, reason }`                                              |
| [`get`](./docs/API.md#getctx-key-scope---status-result-expiresat---null)      | method, `runQuery` ctx (query, mutation or action) | Read a key's `status`, `result` and `expiresAt`, or `null`                                                            |
| [`purge`](./docs/API.md#purgectx-opts--number)                                | method, `runMutation` ctx (mutation or action)     | Delete expired keys in batches; returns the count removed in the first pass                                           |
| [`IdempotencyOptions`](./docs/API.md#client)                                  | type                                               | Constructor options: `defaultScope`, `defaultInflightTtlMs`, `defaultDoneTtlMs`, `upsertOnMissing`, `resultValidator` |
| [`BeginResult`](./docs/API.md#beginctx-key-opts--beginresult)                 | type                                               | Return type of `begin`                                                                                                |
| [`CompleteResult`](./docs/API.md#completectx-key-result-opts--completeresult) | type                                               | Return type of `complete`                                                                                             |
| [`KeyState`](./docs/API.md#getctx-key-scope---status-result-expiresat---null) | type                                               | Return type of `get` (when not `null`)                                                                                |
| [`ResultParser`](./docs/API.md#client)                                        | type                                               | `(value: unknown) => TResult`, the shape of `resultValidator`                                                         |
| [`IdempotencyComponent`](./docs/API.md#client)                                | type                                               | The function references the client needs (`components.idempotency`)                                                   |
| [`convex.config` default](./docs/API.md#entry-points)                         | component (`/convex.config`)                       | The component definition for `app.use(...)`, mounted as `idempotency`                                                 |
| [`register`](./docs/API.md#entry-points)                                      | function (`/test`)                                 | `register(t, name = "idempotency")` mounts the component in a `convex-test` instance                                  |
| [`ComponentApi`](./docs/API.md#entry-points)                                  | type (`/_generated/component`)                     | Generated type of the mounted component's functions                                                                   |

## Common tasks

**Scope keys per tenant.** Keys are unique per `(scope, key)`. Pass `scope` to
`begin`, `complete` and `get`, or set `defaultScope` once:

```ts
// convex/tenant_keys.ts
import { v } from "convex/values";
import { Idempotency } from "@vllnt/convex-idempotency";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

const idem = new Idempotency<{ orderId: string }>(components.idempotency);

export const placeTenantOrder = mutation({
  args: { requestId: v.string(), item: v.string() },
  handler: async (ctx, { requestId, item }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new Error("Unauthenticated");
    const scope = identity.tokenIdentifier;
    const claim = await idem.begin(ctx, requestId, { scope });
    if (claim.state === "done") return claim.result ?? null;
    if (claim.state === "inflight") throw new Error("Retry later");
    const result = { orderId: await ctx.db.insert("orders", { item }) };
    await idem.complete(ctx, requestId, result, {
      scope,
      claimId: claim.claimId,
    });
    return result;
  },
});
```

**Validate the stored result.** The ledger stores `result` as an opaque value.
Pass `resultValidator` to check it on `begin`, `get` and `complete`:

```ts
// convex/validated.ts
import { Idempotency } from "@vllnt/convex-idempotency";
import { components } from "./_generated/api";

export const idem = new Idempotency<{ accepted: boolean }>(
  components.idempotency,
  {
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
  },
);
```

**Run external work from an action.** Claim in one mutation, call the provider
from the action, and record in a second mutation. Carry the same `scope` and
`claimId` through both. Do not run the work for an `inflight` claim.

**Handle a lost claim.** `complete` returns `{ recorded: false, reason }` when
the claim was lost:

| `reason`       | Meaning                                                  | What to do                                              |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `missing`      | No row for this key (never claimed, or purged)           | Set `upsertOnMissing: true` to record the result anyway |
| `expired`      | The inflight lease ran out before `complete`             | Raise `inflightTtlMs`, or set `upsertOnMissing: true`   |
| `superseded`   | A newer `begin` re-claimed the key after the lease ended | Do not overwrite; the newer attempt owns the key        |
| `already_done` | Another attempt already recorded a result                | Read it with `get`                                      |

**Purge on your own schedule.** A built-in daily cron deletes expired keys. To
sweep more often, call `idem.purge(ctx)` from your own cron.

**Test your app.** Mount the component in `convex-test`; see
[Testing your app](#testing-your-app).

## Errors and fixes

Invalid arguments throw a `ConvexError` whose `data.code` is one of these:

| Error (`data.code`) | Message                                          | Cause                                                                         | Fix                                                     |
| ------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| `INVALID_KEY`       | `key must not be empty`                          | `begin` or `complete` got `key: ""`                                           | Pass a non-empty key, such as the request ID            |
| `INVALID_SCOPE`     | `scope must not be empty`                        | `begin` or `complete` got `scope: ""`, or `defaultScope` is `""`              | Pass a non-empty `scope` and a non-empty `defaultScope` |
| `INVALID_TTL`       | `inflightTtlMs must be a positive finite number` | `inflightTtlMs` or `defaultInflightTtlMs` is `0`, negative, `NaN` or infinite | Pass a positive number of milliseconds                  |
| `INVALID_TTL`       | `doneTtlMs must be a positive finite number`     | `doneTtlMs` or `defaultDoneTtlMs` is `0`, negative, `NaN` or infinite         | Pass a positive number of milliseconds                  |
| `INVALID_BATCH`     | `batch must be an integer between 1 and 500`     | `purge` got a `batch` outside 1 to 500, or not an integer                     | Pass an integer from 1 to 500, or omit it (default 200) |
| `INVALID_BEFORE`    | `before must be finite`                          | `purge` got `before` as `NaN` or infinite                                     | Omit `before`, or pass a finite millisecond timestamp   |
| (your error)        | whatever `resultValidator` throws                | The stored or passed `result` failed your validator                           | Fix the validator, or the value passed to `complete`    |

## Limits and gotchas

- Defaults: inflight lease `60_000` ms, done grace `86_400_000` ms (24 h),
  scope `"global"`, purge batch `200` (max `500`), purge cron every 24 h.
- Not exactly-once for external side effects: a worker can finish the external
  call and crash before `complete`. Use the provider's idempotency key too.
- An expired key is claimed `fresh` again by the next `begin`, even if it was
  `done`. After the done grace ends, the work can run again.
- `get` returns expired rows until `purge` deletes them or `begin` re-claims
  them. Compare `expiresAt` with the current time to know if a key is live.
- `get` does not reject an empty `key` or `scope`; it looks the pair up like
  any other. Only rows written by 0.1.0 and its canaries, which allowed empty
  values, can match.
- `purge` trusts `before`. A future `before` also deletes live keys, so those
  operations can run again. Never take it from client input.
- `complete` without `claimId` is accepted only for a key's first claim. After a
  re-claim it returns `superseded`. Always pass the `claimId` from `begin`.
- Time comes from the server clock. No function takes a caller's `now`.
- The component does no auth. Check the caller before calling the client.
- `result` must be a Convex value. It is stored in the key's row, so it counts
  toward Convex's 1 MiB document limit.

## Compatibility

- Peer dependency: `convex@^1.45.0`. CI builds and tests against the locked
  dev version, `convex` 1.51.0.
- Runtime: the client and the component run inside Convex functions. The
  `convex` package's `engines` field asks for Node 20 or later (1.45 to 1.48)
  or Node 22 or later (1.49 and up).
- TypeScript: built with `strict` and `exactOptionalPropertyTypes`. Relative
  imports end in `.js`, so a consumer can type-check it under `bundler` or
  `nodenext` module resolution.
- `@vllnt/convex-idempotency/test` needs `convex-test` and Vitest (Vite's
  `import.meta.glob`) in your app.
- No React entry point: this package is backend only.

## Testing

```bash
pnpm test           # single run
pnpm test:coverage  # 100% enforced on the source files listed in vitest.config.mts
```

Tests run the component's real functions in `convex-test`'s in-memory backend
(`@edge-runtime/vm`); the component code itself is not mocked.

### Testing your app

`@vllnt/convex-idempotency/test` exports `register(t, name = "idempotency")` to
mount the component in a `convex-test` instance built from your app's schema:

```ts
// convex/orders.test.ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register } from "@vllnt/convex-idempotency/test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

test("a retried placeOrder returns the first orderId", async () => {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  register(t);
  const first = await t.mutation(api.orders.placeOrder, {
    requestId: "r1",
    item: "book",
  });
  const retry = await t.mutation(api.orders.placeOrder, {
    requestId: "r1",
    item: "book",
  });
  expect(first?.orderId).toBeTypeOf("string");
  expect(retry?.orderId).toBe(first?.orderId);
});
```

## Security

- Auth-agnostic: the host resolves identity and decides who may run an
  operation.
- Tables sandboxed: reached only through the exported functions.
- Server-sourced expiry: a skewed client clock can't hijack a replay or bypass
  dedup; `key`, `scope` and `result` stay opaque.

See [docs/API.md](./docs/API.md).

## Related packages

- [`@vllnt/convex-quota`](https://oss.vllnt.com/packages/convex-quota): its example app mounts both components (`app.use(idempotency)`) and wraps `quota.consume` and refund in `begin` → `complete` inside one mutation, so a retried consume is not counted twice.

## Contributing

See
[CONTRIBUTING.md](https://github.com/vllnt/convex-idempotency/blob/main/CONTRIBUTING.md).

## Links

- Docs and changelog: [oss.vllnt.com/packages/convex-idempotency](https://oss.vllnt.com/packages/convex-idempotency) · [release feed](https://oss.vllnt.com/packages/convex-idempotency/rss.xml)
- All @vllnt packages: [oss.vllnt.com](https://oss.vllnt.com) · [search packages and docs on index.vllnt.com](https://index.vllnt.com)
- Source and issues: [GitHub](https://github.com/vllnt/convex-idempotency) · [issues](https://github.com/vllnt/convex-idempotency/issues) · [npm](https://www.npmjs.com/package/@vllnt/convex-idempotency)
- Questions and updates: [Discord](https://bntvllnt.com/discord) · [X @bntvllnt](https://x.com/bntvllnt)
- Company and author: [vllnt.com](https://vllnt.com) · [bntvllnt.com](https://bntvllnt.com) · [GitHub @bntvllnt](https://github.com/bntvllnt) · [LinkedIn](https://linkedin.com/in/bntvllnt)
- Sponsor: [GitHub Sponsors](https://github.com/sponsors/bntvllnt)

## License

MIT, see [LICENSE](./LICENSE).

---

Part of [vllnt open source](https://oss.vllnt.com) · [Package page](https://oss.vllnt.com/packages/convex-idempotency) · [vllnt.com](https://vllnt.com) · Built by [bntvllnt](https://bntvllnt.com)
