import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The example host app's own tables used by the effect-once and crash-recovery
 * tests. These are host-side state — they prove a component-gated side-effect ran
 * exactly once.
 */
export default defineSchema({
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),
});
