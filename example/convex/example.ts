import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { Idempotency } from "../../src/client";

/**
 * Host-app wrappers. The host owns auth: resolve identity here, then pass an
 * opaque `key` (and optional `scope`) into the idempotency client. Time is
 * server-sourced inside the component — there is no `now` override to pass.
 */
const idem = new Idempotency<{ chargeId: string } | string | number>(
  components.idempotency,
);

/** A second client with non-default options — exercises the client default branches. */
const tenantIdem = new Idempotency(components.idempotency, {
  defaultScope: "tenant",
  defaultInflightTtlMs: 1000,
  defaultDoneTtlMs: 1000,
});

/** A client that upserts a lost claim and validates results against a host parser. */
const strictIdem = new Idempotency<{ ok: boolean }>(components.idempotency, {
  defaultScope: "strict",
  upsertOnMissing: true,
  resultValidator: (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { ok?: unknown }).ok !== "boolean"
    ) {
      throw new Error("invalid result: expected { ok: boolean }");
    }
    return value as { ok: boolean };
  },
});

const beginResult = v.union(
  v.object({ state: v.literal("fresh") }),
  v.object({
    state: v.literal("inflight"),
    expiresAt: v.number(),
    retryAfterMs: v.number(),
  }),
  v.object({ state: v.literal("done"), result: v.optional(v.any()) }),
);

const completeResult = v.union(
  v.object({ recorded: v.literal(true) }),
  v.object({
    recorded: v.literal(false),
    reason: v.union(
      v.literal("missing"),
      v.literal("expired"),
      v.literal("already_done"),
    ),
  }),
);

const keyState = v.union(
  v.null(),
  v.object({
    status: v.union(v.literal("inflight"), v.literal("done")),
    result: v.optional(v.any()),
    expiresAt: v.number(),
  }),
);

export const begin = mutation({
  args: {
    key: v.string(),
    scope: v.optional(v.string()),
    inflightTtlMs: v.optional(v.number()),
  },
  returns: beginResult,
  handler: (ctx, a) =>
    idem.begin(ctx, a.key, { scope: a.scope, inflightTtlMs: a.inflightTtlMs }),
});

export const complete = mutation({
  args: {
    key: v.string(),
    result: v.optional(v.any()),
    scope: v.optional(v.string()),
    doneTtlMs: v.optional(v.number()),
    upsertOnMissing: v.optional(v.boolean()),
  },
  returns: completeResult,
  handler: (ctx, a) =>
    idem.complete(ctx, a.key, a.result, {
      scope: a.scope,
      doneTtlMs: a.doneTtlMs,
      upsertOnMissing: a.upsertOnMissing,
    }),
});

export const get = query({
  args: { key: v.string(), scope: v.optional(v.string()) },
  returns: keyState,
  handler: (ctx, a) => idem.get(ctx, a.key, a.scope),
});

export const purge = mutation({
  args: { before: v.optional(v.number()), batch: v.optional(v.number()) },
  returns: v.number(),
  handler: (ctx, a) => idem.purge(ctx, { before: a.before, batch: a.batch }),
});

/** Tenant client variants — exercise the `defaultScope` / ttl default branches. */
export const beginTenant = mutation({
  args: { key: v.string() },
  returns: beginResult,
  handler: (ctx, a) => tenantIdem.begin(ctx, a.key),
});

export const getTenant = query({
  args: { key: v.string() },
  returns: keyState,
  handler: (ctx, a) => tenantIdem.get(ctx, a.key),
});

export const purgeTenant = mutation({
  args: {},
  returns: v.number(),
  handler: (ctx) => tenantIdem.purge(ctx),
});

/** Strict client variants — exercise `resultValidator` + `upsertOnMissing`. */
export const beginStrict = mutation({
  args: { key: v.string() },
  returns: beginResult,
  handler: (ctx, a) => strictIdem.begin(ctx, a.key),
});

export const completeStrict = mutation({
  args: { key: v.string(), result: v.any() },
  returns: completeResult,
  handler: (ctx, a) => strictIdem.complete(ctx, a.key, a.result),
});

export const getStrict = query({
  args: { key: v.string() },
  returns: keyState,
  handler: (ctx, a) => strictIdem.get(ctx, a.key),
});
