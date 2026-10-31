import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { keyState } from "./validators.js";

export const get = query({
  args: { key: v.string(), scope: v.string() },
  returns: v.union(v.null(), keyState),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("keys")
      .withIndex("by_scope_key", (q) =>
        q.eq("scope", args.scope).eq("key", args.key),
      )
      .unique();
    if (row === null) {
      return null;
    }
    return {
      status: row.status,
      result: row.result,
      expiresAt: row.expiresAt,
    };
  },
});
