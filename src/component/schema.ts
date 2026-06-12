import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { jsonValue } from "./validators";

/**
 * Sandboxed tables — the idempotency ledger's own concern. A `key` is unique
 * within a `scope`; `result` carries the opaque host-owned outcome (never
 * inspected). `expiresAt` is an absolute ms timestamp that bounds the grace
 * window after which a key may be re-minted.
 */
export default defineSchema({
  keys: defineTable({
    key: v.string(),
    scope: v.string(),
    status: v.union(v.literal("inflight"), v.literal("done")),
    result: v.optional(jsonValue),
    expiresAt: v.number(),
  })
    .index("by_scope_key", ["scope", "key"])
    .index("by_expires", ["expiresAt"]),
});
