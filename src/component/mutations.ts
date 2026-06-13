import { ConvexError, v } from "convex/values";
import { api } from "./_generated/api";
import { mutation } from "./_generated/server";
import { beginResult, completeResult, jsonValue } from "./validators";

/**
 * Claim `key` within `scope`. Time is read from the server (`Date.now()`) inside
 * the handler — never supplied by the caller — so an adversarial clock cannot
 * force a key to look expired or live. `inflightTtlMs` bounds the inflight lease:
 * a crashed worker self-heals once its short lease lapses, after which the key is
 * re-minted in place (the row id is reused, not deleted and re-inserted).
 *
 * **Expiry check order (intentional asymmetry):** `begin` checks expiry BEFORE
 * the done-state. An expired done key is therefore re-minted `fresh` (the
 * outcome's grace window has elapsed; the key behaves as never-seen). This is the
 * correct recovery path — the done grace exists precisely to replay within the
 * window; outside it the operation may safely re-run.
 *
 * @throws `ConvexError({ code: "INVALID_TTL" })` when `inflightTtlMs` is not a
 *   positive finite number (≤ 0 or non-finite would produce `expiresAt ≤ now`,
 *   immediately expiring the claim and breaking the dedup window).
 */
export const begin = mutation({
  args: {
    key: v.string(),
    scope: v.string(),
    inflightTtlMs: v.number(),
  },
  returns: beginResult,
  handler: async (ctx, args) => {
    if (!(args.inflightTtlMs > 0 && isFinite(args.inflightTtlMs))) {
      throw new ConvexError({
        code: "INVALID_TTL",
        message: "inflightTtlMs must be a positive finite number",
      });
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("keys")
      .withIndex("by_scope_key", (q) =>
        q.eq("scope", args.scope).eq("key", args.key),
      )
      .unique();

    const expiresAt = now + args.inflightTtlMs;

    if (existing === null) {
      await ctx.db.insert("keys", {
        key: args.key,
        scope: args.scope,
        status: "inflight",
        expiresAt,
      });
      return { state: "fresh" as const };
    }

    if (existing.expiresAt <= now) {
      await ctx.db.patch(existing._id, {
        status: "inflight",
        result: undefined,
        expiresAt,
      });
      return { state: "fresh" as const };
    }

    if (existing.status === "done") {
      return { state: "done" as const, result: existing.result };
    }

    return {
      state: "inflight" as const,
      expiresAt: existing.expiresAt,
      retryAfterMs: existing.expiresAt - now,
    };
  },
});

/**
 * Mark `key` `done`, recording `result` and extending the grace window by
 * `doneTtlMs`. Returns a discriminated outcome so the host can detect a lost
 * claim: `recorded: false` with `missing` (key never existed), `expired` (the
 * inflight lease lapsed before completion), or `already_done` (a prior attempt
 * won). When `upsertOnMissing` is set, a `missing`/`expired` key is written as
 * `done` anyway — for hosts that would rather record the finished work than drop
 * it. Time is server-sourced.
 *
 * **Expiry check order (intentional asymmetry):** `complete` checks the
 * done-state BEFORE expiry. An expired done key therefore returns
 * `already_done`, not `expired`. This is intentional: a worker that manages to
 * call `complete` on a key that is already `done` — even if the done row's grace
 * window has since lapsed — must not overwrite a prior winner's recorded outcome.
 * The `expired` reason is reserved for inflight keys whose lease lapsed before
 * the holder could complete; it does not apply to keys already marked done.
 *
 * @throws `ConvexError({ code: "INVALID_TTL" })` when `doneTtlMs` is not a
 *   positive finite number (≤ 0 or non-finite would produce `expiresAt ≤ now`,
 *   immediately expiring the done grace window on creation).
 */
export const complete = mutation({
  args: {
    key: v.string(),
    scope: v.string(),
    result: v.optional(jsonValue),
    doneTtlMs: v.number(),
    upsertOnMissing: v.boolean(),
  },
  returns: completeResult,
  handler: async (ctx, args) => {
    if (!(args.doneTtlMs > 0 && isFinite(args.doneTtlMs))) {
      throw new ConvexError({
        code: "INVALID_TTL",
        message: "doneTtlMs must be a positive finite number",
      });
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("keys")
      .withIndex("by_scope_key", (q) =>
        q.eq("scope", args.scope).eq("key", args.key),
      )
      .unique();

    const expiresAt = now + args.doneTtlMs;

    if (existing === null) {
      if (args.upsertOnMissing) {
        await ctx.db.insert("keys", {
          key: args.key,
          scope: args.scope,
          status: "done",
          result: args.result,
          expiresAt,
        });
        return { recorded: true as const };
      }
      return { recorded: false as const, reason: "missing" as const };
    }

    if (existing.status === "done") {
      return { recorded: false as const, reason: "already_done" as const };
    }

    if (existing.expiresAt <= now) {
      if (args.upsertOnMissing) {
        await ctx.db.patch(existing._id, {
          status: "done",
          result: args.result,
          expiresAt,
        });
        return { recorded: true as const };
      }
      return { recorded: false as const, reason: "expired" as const };
    }

    await ctx.db.patch(existing._id, {
      status: "done",
      result: args.result,
      expiresAt,
    });
    return { recorded: true as const };
  },
});

/**
 * Delete up to `batch` keys whose `expiresAt < before`, oldest first via the
 * `by_expires` index. `before` defaults to the server clock (`Date.now()`) when
 * omitted, so the built-in cron sweeps exactly the keys expired as of the run —
 * a caller cannot pass a future cutoff it did not compute. If a full batch was
 * removed there may be more, so the sweep self-reschedules through
 * `ctx.scheduler` until a short batch signals the tail is clean. Idempotent:
 * re-running only ever removes already-expired rows.
 */
export const purge = mutation({
  args: { before: v.optional(v.number()), batch: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const before = args.before ?? Date.now();
    const stale = await ctx.db
      .query("keys")
      .withIndex("by_expires", (q) => q.lt("expiresAt", before))
      .take(args.batch);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    if (stale.length === args.batch) {
      await ctx.scheduler.runAfter(0, api.mutations.purge, {
        before,
        batch: args.batch,
      });
    }
    return stale.length;
  },
});
